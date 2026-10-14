#!/usr/bin/env node
/**
 * 变异验证（mutation verification）：确认**关键安全断言真的在拦事**（2026-10-13）。
 *
 * 由来（真实教训）：本轮为跨项目授权补了 3 条"受保护存储不得访问"的反例，
 * 其中一条（删除审计文件）在**临时禁用产品判定器**后**仍然通过** ——
 * 因为它先命中了 `resource-not-found`，**根本没走到受保护存储判定**。
 * ⇒ "测试通过"不等于"测试有效"；空洞反例会让防线看起来存在而实际不存在。
 *
 * 本脚本把那次手工实验固化为**可复用检查**：对每条关键安全断言，
 * 用精确字符串替换在产品代码里**注入一处反事实**，跑指定用例，
 * 要求**点名的那几条用例必须变红**；最后**必定还原**（sha256 校验）。
 *
 * 判定：任一变异"存活"（期望红却没红）⇒ 该变异**没被测住** ⇒ 退出码 1。
 *
 * 用法：
 *   node scripts/verify-mutation-kills.mjs            # 全部变异
 *   node scripts/verify-mutation-kills.mjs --json     # 机器可读
 *   node scripts/verify-mutation-kills.mjs --only <mutationIdentifier>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * 每个变异：
 *  - targetFile：被注入反事实的产品源文件（仓库相对路径）
 *  - find / replace：**精确**字符串替换（必须唯一命中，否则脚本报错而不是猜）
 *  - testFiles：要跑的用例文件
 *  - expectedFailingTestNames：**必须**出现在失败列表里的用例名片段
 *  - rationale：这条断言在拦什么（失败信息里会打印，便于人读懂）
 */
export const MUTATIONS = [
  {
    mutationIdentifier: "cross-project-forbidden-access-target-disabled",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `    const isForbiddenAccessTarget = this.options.isForbiddenAccessTarget;
    if (
      isForbiddenAccessTarget !== undefined &&
      (await isForbiddenAccessTarget(binding.resolvedAbsolutePath))
    ) {`,
    replace: `    const isForbiddenAccessTarget = this.options.isForbiddenAccessTarget;
    if (false && isForbiddenAccessTarget !== undefined) {`,
    testFiles: [
      "tests/core/integration/cross-project-resource-io.test.ts",
      "tests/core/integration/cross-project-sdk-entry.test.ts",
    ],
    expectedFailingTestNames: [
      "受保护存储（backup-vault / 删除审计）不得经跨项目通道访问",
      "副本导入：**来源**是受保护存储时不得被拷出去",
      "受保护存储之删除审计文件同样不得经跨项目通道读取",
      "SDK 入口：受保护存储（backup-vault）不得经跨项目通道读取",
    ],
    rationale: "受保护存储判定被禁用时，保管库/审计文件必须仍被拒绝（fail-closed 防线）",
  },
  {
    mutationIdentifier: "cross-project-target-filename-binding-relaxed",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `      if (canonicalizedActualPath !== expectedCanonicalTargetPath) {`,
    replace: `      if (path.dirname(canonicalizedActualPath) !== path.dirname(expectedCanonicalTargetPath)) {`,
    testFiles: ["tests/core/integration/cross-project-resource-io.test.ts"],
    expectedFailingTestNames: [
      "副本导入：目标绝对路径与「目标项目根 + 声明路径」不一致时必须拒绝",
    ],
    rationale:
      "把'完整规范路径比对'放宽成'只比父目录'后，'同目录换个文件名'必须仍被拒绝（否则目标可被调包）",
  },
  {
    mutationIdentifier: "tool-package-reauthorization-gate-removed",
    targetFile: "packages/core/src/toolkit/tool-package-version-state-store.ts",
    find: `    if (differences.requiresReauthorization) {
      const recordIdentifier = input.reauthorizationRecordIdentifier;`,
    replace: `    if (false && differences.requiresReauthorization) {
      const recordIdentifier = input.reauthorizationRecordIdentifier;`,
    testFiles: ["tests/core/integration/toolkit01-reauthorization-gate.test.ts"],
    expectedFailingTestNames: [
      "无重新授权记录 ⇒ 必须拒绝",
      "给了不存在的记录标识 ⇒ 必须拒绝",
      "记录与本次操作绑定不匹配 ⇒ 必须拒绝",
      "记录已被消费 ⇒ 必须拒绝",
    ],
    rationale:
      "把'以本地签发的重新授权记录为依据'的门禁整段短路后，无记录/记录不存在/绑定不匹配/已消费四种情形必须全部变红" +
      "（否则等于门禁形同虚设，调用方又能凭自述放行）",
  },
  {
    mutationIdentifier: "tool-package-reauthorization-single-use-removed",
    targetFile: "packages/core/src/toolkit/tool-package-reauthorization-record-store.ts",
    find: `    if (record.consumedAtIso !== null) {`,
    replace: `    if (false && record.consumedAtIso !== null) {`,
    testFiles: [
      "tests/core/unit/toolkit01-reauthorization-record-store.test.ts",
      "tests/core/integration/toolkit01-reauthorization-gate.test.ts",
    ],
    expectedFailingTestNames: [
      "一次性：同一条记录不得二次放行",
      "记录已被消费 ⇒ 必须拒绝",
    ],
    rationale:
      "去掉'一次性消费'后，同一条批准不得能反复升级（否则一次批准可被无限复用）",
  },
  {
    /**
     * 2026-10-22 订正：原两条变异（`comm01-single-parent-uniqueness-removed`、
     * `comm01-direct-parent-check-relaxed`）针对的是**错误模型**
     * （"唯一上级 = 通信授权"），已随实现一并删除。
     * 依 `docs/AGENT_COMMUNICATION_OVERVIEW.md` §35–54 与用户澄清，
     * 正确语义是"创建来源登记 + 地址完整性"（无绑定记录 ⇒ 直接拒绝）。
     */
    mutationIdentifier: "comm01-unknown-recipient-accepted",
    targetFile: "packages/core/src/orchestration/agent-parent-binding-store.ts",
    find: `    const record = await this.registry.getRecord(recipientAgentInstanceId);
    if (record === null) {
      return false;
    }
    return record.recycledAtIso === null;`,
    replace: `    const record = await this.registry.getRecord(recipientAgentInstanceId);
    if (false && record === null) {
      return false;
    }
    return record === null || record.recycledAtIso === null;`,
    testFiles: ["tests/core/integration/comm01-agent-creation-registry.test.ts"],
    expectedFailingTestNames: ["**无绑定记录**的收件人 ⇒ 直接拒绝"],
    rationale:
      "放宽'无绑定记录即拒收'后，未知地址会被当作可投递主体" +
      "（用户澄清的硬规则：投递到无绑定记录的对象**直接拒绝**）",
  },
  {
    mutationIdentifier: "comm01-creation-provenance-not-persisted",
    targetFile: "packages/core/src/orchestration/agent-parent-binding-store.ts",
    find: `      if (parsed.schemaVersion !== 1) {
        return;
      }`,
    replace: `      if (false && parsed.schemaVersion !== 1) {
        return;
      }`,
    testFiles: ["tests/core/integration/comm01-agent-creation-registry.test.ts"],
    expectedFailingTestNames: ["`schemaVersion` 不符 ⇒ 按空继续"],
    rationale:
      "不再按 schemaVersion 拒收后，异版本文档里的记录会被当作**存在的主体**" +
      "⇒ 未知地址变成可投递（伪造存在性）",
  },
  {
    mutationIdentifier: "comm01-delivery-address-check-skipped",
    targetFile: "packages/core/src/feedback-process/delivery-worker.ts",
    find: `    const isRecipientAddressKnown = this.dependencies.isRecipientAddressKnown;
    if (isRecipientAddressKnown !== undefined) {
      const isKnown = await isRecipientAddressKnown(nextMessage);
      if (!isKnown) {`,
    replace: `    const isRecipientAddressKnown = this.dependencies.isRecipientAddressKnown;
    if (false && isRecipientAddressKnown !== undefined) {
      const isKnown = await isRecipientAddressKnown(nextMessage);
      if (!isKnown) {`,
    testFiles: ["tests/core/integration/comm01-delivery-address-integrity.test.ts"],
    expectedFailingTestNames: [
      "收件人**无绑定记录** ⇒ 不投递、不标记已投递",
      "真实 AgentCreationRegistry 端到端",
    ],
    rationale:
      "把投递步骤的地址完整性整段短路后，'无绑定记录 / 已回收的收件人不得投递'必须变红" +
      "（否则该检查只写在模块里、在真实投递路径上并不生效）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-authority-check-skipped",
    targetFile: "packages/core/src/toolkit/tool-package-operation-control.ts",
    find: `  if (input.authorizationController !== undefined) {
    const authority = await input.authorizationController.resolveIssuingAuthority({`,
    replace: `  if (false && input.authorizationController !== undefined) {
    const authority = await input.authorizationController.resolveIssuingAuthority({`,
    testFiles: ["tests/core/integration/toolkit01-reauthorization-gate.test.ts"],
    expectedFailingTestNames: ["**无资格的 Agent** 不得签发"],
    rationale:
      "短路'签发资格'判定后，未获授予的 Agent 又能在**真实签发入口**上凭空签发" +
      "（用户澄清：默认只有用户持有该权限，Agent 须经显式授予）",
  },
  {
    mutationIdentifier: "toolkit01-delegation-amplification-allowed",
    targetFile: "packages/core/src/toolkit/tool-upgrade-authorization-grant.ts",
    find: `      if (ownValidGrant.expiresAtIso !== null) {
        if (requestedExpiry === null) {`,
    replace: `      if (false && ownValidGrant.expiresAtIso !== null) {
        if (requestedExpiry === null) {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-authorization.test.ts"],
    expectedFailingTestNames: [
      "**逐层分发不得放大**：自身有期限时不得授出无期限能力",
      "**逐层分发不得放大**：授出期限不得晚于自身期限",
    ],
    rationale:
      "放开'不得放大'后，下级可授出无期限/更长期限的能力 ⇒ 逐层分发变成权限膨胀" +
      "（用户要求'向下级逐层分发'但**不得放大**）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-declaration-modes-not-required",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `  if (missingModes.length > 0) {`,
    replace: `  if (false && missingModes.length > 0) {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["**缺少任一模式** ⇒ 拒绝"],
    rationale:
      "不再要求三模式齐全后，升级包可以只声明一部分模式就落地" +
      "（用户明确要求'必须显式声明三种模式的默认权限规则和理由'）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-declaration-reason-not-required",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `      if (rule.reason.trim() === "") {`,
    replace: `      if (false && rule.reason.trim() === "") {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["但**规则没有理由** ⇒ 拒绝"],
    rationale:
      "不再要求理由后，升级包可加开关却不说为什么" +
      "（用户明确要求'显式声明三种模式的默认权限规则**和理由**'）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-removed-feature-rules-kept",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `  const retainedRules = input.existingRules.filter((rule) => {
    const key = rule.ruleIdentifier ?? rule.action;
    return !removedFeatureIdentifiers.has(key);
  });`,
    replace: `  const retainedRules = input.existingRules.filter((rule) => {
    const key = rule.ruleIdentifier ?? rule.action;
    return true || !removedFeatureIdentifiers.has(key);
  });`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["**消失的功能** ⇒ 移除其旧规则"],
    rationale:
      "不再移除消失功能的旧规则后，'消失的功能也要对应移除旧的权限管理开关'这条就不成立" +
      "（会留下指向已不存在功能的僵尸开关）",
  },
  {
    mutationIdentifier: "comm01-feedback-ignores-task-publisher",
    targetFile: "packages/core/src/orchestration/worker-agent.ts",
    find: `      recipientId: route.recipientId,`,
    replace: `      recipientId: \`scheduler:\${this.options.missionId}\`,`,
    testFiles: [
      "tests/core/unit/worker-agent.test.ts",
      "tests/core/unit/comm01-task-publisher-feedback-route.test.ts",
    ],
    expectedFailingTestNames: [
      "任务记录了发布者 ⇒ 反馈**投给发布者**而非默认 scheduler",
    ],
    rationale:
      "把反馈去向改回硬编码 scheduler 后，'反馈走任务发布者反向通道'必须变红" +
      "（用户澄清：反馈**不是**根据上下级关系，而是默认走任务发布者的反向通道）",
  },
];

function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseJsonReport(reportPath) {
  const rawText = readFileSync(reportPath, "utf8");
  const trimmed = rawText.trim();
  // vitest --reporter=json 可能带前导日志行，取第一个 '{' 起解析。
  const startIndex = trimmed.indexOf("{");
  if (startIndex === -1) {
    throw new Error("未找到 JSON 报告内容");
  }
  return JSON.parse(trimmed.slice(startIndex));
}

function collectFailedTestNames(report) {
  const failedNames = new Set();
  for (const testResult of report.testResults ?? []) {
    for (const assertion of testResult.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failedNames.add(String(assertion.fullName ?? assertion.title ?? ""));
      }
    }
  }
  return failedNames;
}

function runMutation(mutation, options) {
  const targetPath = path.join(repositoryRootDirectory, mutation.targetFile);
  const originalContent = readFileSync(targetPath, "utf8");
  const originalDigest = sha256OfFile(targetPath);

  const occurrenceCount = originalContent.split(mutation.find).length - 1;
  if (occurrenceCount !== 1) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage:
        `锚点在 ${mutation.targetFile} 中命中 ${occurrenceCount} 次（要求恰好 1 次）——` +
        "说明源码已改动，请同步更新脚本里的 find 片段（不要让它静默跳过）",
      failedTestNames: [],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  const mutatedContent = originalContent.replace(mutation.find, mutation.replace);
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "astarray-mutation-"));
  const reportPath = path.join(temporaryDirectory, "vitest-report.json");

  let failedTestNames = new Set();
  let runError = null;
  try {
    writeFileSync(targetPath, mutatedContent, "utf8");
    try {
      execFileSync(
        process.execPath,
        [
          path.join(repositoryRootDirectory, "node_modules", "vitest", "vitest.mjs"),
          "run",
          ...mutation.testFiles,
          "--reporter=json",
          `--outputFile=${reportPath}`,
        ],
        { cwd: repositoryRootDirectory, stdio: "inherit" },
      );
      // 注入了反事实 ⇒ 期望 vitest 失败；若这里正常返回说明"用例没红"。
      runError = "vitest 在注入反事实后仍然通过（该变异存活）";
    } catch {
      // 期望路径：存在失败用例。
    }
    try {
      failedTestNames = collectFailedTestNames(parseJsonReport(reportPath));
    } catch (error) {
      if (runError === null) {
        runError = `无法解析 vitest JSON 报告：${String(error)}`;
      }
    }
  } finally {
    writeFileSync(targetPath, originalContent, "utf8");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const restoredDigest = sha256OfFile(targetPath);
  if (restoredDigest !== originalDigest) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage: `还原失败：${mutation.targetFile} 的 sha256 与注入前不一致`,
      failedTestNames: [...failedTestNames],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  const missingExpectations = mutation.expectedFailingTestNames.filter(
    (expectedNameFragment) =>
      ![...failedTestNames].some((failedName) => failedName.includes(expectedNameFragment)),
  );

  return {
    mutationIdentifier: mutation.mutationIdentifier,
    isKilled: missingExpectations.length === 0,
    isScriptError: false,
    errorMessage: runError,
    failedTestNames: [...failedTestNames],
    expectedFailingTestNames: mutation.expectedFailingTestNames,
    missingExpectations,
    rationale: mutation.rationale,
  };
}

function main() {
  const argumentsList = process.argv.slice(2);
  const isJsonOutput = argumentsList.includes("--json");
  const onlyIndex = argumentsList.indexOf("--only");
  const onlyIdentifier = onlyIndex === -1 ? null : argumentsList[onlyIndex + 1];

  const selectedMutations =
    onlyIdentifier === null
      ? MUTATIONS
      : MUTATIONS.filter((mutation) => mutation.mutationIdentifier === onlyIdentifier);

  if (selectedMutations.length === 0) {
    process.stderr.write(`未找到匹配的变异：${String(onlyIdentifier)}\n`);
    process.exitCode = 1;
    return;
  }

  const outcomes = [];
  for (const mutation of selectedMutations) {
    if (!isJsonOutput) {
      process.stdout.write(`\n── 变异 ${mutation.mutationIdentifier} ──\n`);
      process.stdout.write(`   ${mutation.rationale}\n`);
    }
    const outcome = runMutation(mutation, { isJsonOutput });
    outcomes.push(outcome);
    if (!isJsonOutput) {
      if (outcome.isScriptError) {
        process.stdout.write(`   ❌ 脚本错误：${String(outcome.errorMessage)}\n`);
      } else if (outcome.isKilled) {
        process.stdout.write(
          `   ✅ 被拦下（${outcome.expectedFailingTestNames.length} 条点名的用例均变红）\n`,
        );
      } else {
        process.stdout.write(`   ❌ **变异存活**：以下期望变红的用例没有红\n`);
        for (const missing of outcome.missingExpectations ?? []) {
          process.stdout.write(`        - ${missing}\n`);
        }
        if (outcome.errorMessage !== null) {
          process.stdout.write(`        备注：${String(outcome.errorMessage)}\n`);
        }
      }
    }
  }

  const killedCount = outcomes.filter((outcome) => outcome.isKilled).length;
  const allKilled = killedCount === outcomes.length;

  if (isJsonOutput) {
    process.stdout.write(
      JSON.stringify({ killedCount, totalCount: outcomes.length, outcomes }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(
      `\n变异验证：${killedCount}/${outcomes.length} 被拦下` +
        (allKilled ? "（全部通过）\n" : "（存在存活变异 ⇒ 有断言是空的）\n"),
    );
  }

  process.exitCode = allKilled ? 0 : 1;
}

main();
