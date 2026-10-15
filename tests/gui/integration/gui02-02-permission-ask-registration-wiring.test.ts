/**
 * GUI-02-02 反例（2026-11-08）：**GUI 必须登记待决授权请求**。
 *
 * ## 由来（真实用户实测，追到根因）
 *
 * 用户在 GUI 上提交写文件任务后，「待授权」区**永远没有内容**（点刷新也没有）。
 * 我从服务端与磁盘取得对照证据：
 *
 * | 路径 | `agent-memory/<owner>/permission-ask-requests/` |
 * | --- | --- |
 * | CLI `run`（含 headless） | **有**（含真实参数与指纹） |
 * | **GUI** | **连 owner 目录都不存在** |
 *
 * 而 worker 的工作存档**照常**记了「等待权限: createProjectFile」——
 * 所以现象看起来像"请求已产生、只是界面没显示"，**其实是压根没登记**。
 *
 * ## 根因（精确到一处缺失的接线）
 *
 * 登记靠门面方法 `registerPermissionAskRequest`，而它**全仓只有一个调用方**：
 * `packages/tui/src/cli/run-command.ts`。它是在**裁决配置的回调**
 * `onPermissionAskWithIdentity` 里被调用的。
 *
 * 对照两个命令的 `configurePermissionAskAdjudication({...})`：
 *
 * - `run`：传了 `onPermissionAskWithIdentity` ⇒ 会登记；
 * - **`gui`：只传 `authorityPort` / `csrfToken` / `projectRootPath`，没有该回调**
 *   ⇒ **没有任何人登记** ⇒ `/permission-asks` 恒空 ⇒ 待授权区永远空。
 *
 * ## 为什么既有测试没拦住
 *
 * `gui02-02-installation-not-bypassable.test.ts` 等用例**自己构造
 * `startGuiServer` 的应用端口**，不经过 CLI 的 `gui` 命令接线
 * ⇒ **生产接线缺失**这条路径从未被测。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/** 用括号计数取出 `configurePermissionAskAdjudication(` 之后的对象字面量。 */
function extractCallObject(sourceText: string, startIndex: number): string {
  const openIndex = sourceText.indexOf("{", startIndex);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let index = openIndex; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return sourceText.slice(startIndex, index + 1);
    }
  }
  return "";
}

describe("GUI-02-02：GUI 命令必须登记待决授权请求", () => {
  it("① `gui` 的**应用创建选项**必须带 `onPermissionAskWithIdentity`（否则请求永不登记）", async () => {
    const sourceText = await fs.readFile(
      path.resolve("packages/tui/src/cli/commands.ts"),
      "utf8",
    );

    /**
     * ⚠️ 两处我自己踩过的坑，都写进守卫里：
     *
     * 1. **必须在正确的位置找**：`onPermissionAskWithIdentity` 是
     *    `AstarrayApplicationFacade.create({...})` 的选项，**不是**
     *    `configurePermissionAskAdjudication({...})` 的选项 ——
     *    我第一版修就放错了通道，被 `typecheck` 当场拦下（`TS2353`）。
     * 2. **提取必须自校验**：`AstarrayApplicationFacade.create(` 在文件里出现多次，
     *    且注释里也可能出现该串。故遍历所有出现处、只保留"GUI 命令那个"的
     *    （以 `isInstallationGateOnInterface` 为标记），并要求**恰好一个**。
     */
    const candidates: string[] = [];
    for (const match of sourceText.matchAll(/AstarrayApplicationFacade\.create\(/g)) {
      const block = extractCallObject(sourceText, match.index ?? 0);
      if (block.includes("isInstallationGateOnInterface")) {
        candidates.push(block);
      }
    }
    expect(
      candidates.length,
      "未能唯一确定 gui 命令的应用创建选项（找到 " + String(candidates.length) + " 个）",
    ).toBe(1);
    const guiCreationOptions = candidates[0]!;

    /**
     * ⚠️ **必须锚定"属性键"形态，不能只查子串** —— 这是变异探针当场抓到的：
     * 我第一版用 `block.includes("onPermissionAskWithIdentity")`，而**我自己写的
     * JSDoc 注释里就有这个字面量**（在反引号里被引用）⇒ 把**代码里的回调删掉**后
     * 断言**依然通过** ⇒ 一个**空洞守卫**。
     *
     * 改为匹配"行首的属性定义"（`onPermissionAskWithIdentity:` 后跟参数表），
     * 注释里的反引号提及不会被命中。
     */
    expect(
      /^\s*onPermissionAskWithIdentity:\s*\(/m.test(guiCreationOptions),
      "`gui` 命令创建应用时缺少 `onPermissionAskWithIdentity` —— " +
        "实测后果：GUI 下**没有任何人登记**待决授权请求 ⇒ `/permission-asks` 恒空 ⇒ " +
        "界面「待授权」区永远没有内容（用户的原始症状）。" +
        "应照 `run-command.ts` 的写法补上该回调。",
    ).toBe(true);
  });

  it("② 该回调必须**真的调用** `registerPermissionAskRequest`（不得是空实现）", async () => {
    const sourceText = await fs.readFile(
      path.resolve("packages/tui/src/cli/commands.ts"),
      "utf8",
    );

    // 回调存在但内容是空的同样等于没修 ⇒ 必须同时断言登记调用在里面
    expect(sourceText).toContain("registerPermissionAskRequest");
    expect(sourceText).toContain("buildPermissionAskFromEscalation");

    // 登记需要绝对身份与解析后的参数 ⇒ 关键字段不得少
    for (const requiredKey of [
      "ownerAgentInstanceId",
      "taskIdentifier",
      "toolName",
      "argumentsJson",
    ]) {
      expect(
        sourceText.includes(requiredKey),
        "登记调用缺少必需字段：" + requiredKey,
      ).toBe(true);
    }
  });

  it("③ GUI 的**批准分支**必须真的授权并唤醒任务（不得只记录一个 allowed 状态）", async () => {
    /**
     * ## 由来（**自动端到端验证**发现的，比人工更硬的证据）
     *
     * 2026-11-08 我用 GUI 自己的 HTTP 路由把整条链路跑了一遍：
     * `POST /commands/submit` → 轮询 `/permission-asks`（**出现了条目**，登记修复有效）
     * → `POST /commands/permission-ask-decision`（返回 `status:"allowed"`）
     * → 之后**任务停在 `blocked`、产物不存在**。
     *
     * ## 根因：GUI 的批准是**半成品实现**
     *
     * CLI 批准时会做三件事（`packages/tui/src/cli/permission-ask-adjudication.ts`
     * 的授权分支），而 GUI 的覆盖项**只调了 `decidePermissionAskRequest`**（记录裁决）：
     *
     * | # | 必须做 | 作用 |
     * | --- | --- | --- |
     * | ① | `grantSessionAuthorization` | 让重跑时该工具被判 **allow** |
     * | ② | `grantScopeAuthorizationForToolCall` | 重新登记**一次性**作用域授权（被拦下的那次已消费） |
     * | ③ | `sendSchedulerInstruction(mission, {action:"unblock",…})` | **唤醒被阻塞的任务重派发** |
     *
     * 少了这三步 ⇒ "记了个 allowed 的状态"，但**授权没进权限引擎、任务没被唤醒** ⇒
     * 停在 blocked、工具从未执行、**产物永远不落盘**。
     */
    const sourceText = await fs.readFile(
      path.resolve("packages/tui/src/cli/commands.ts"),
      "utf8",
    );

    /**
     * ⚠️ 锚定**调用形态**（点号 + 方法名 + 左括号），不用裸子串 ——
     * 本会话已被"自己的注释命中自己的守卫"绊倒三次（变异探针每次都能抓到）。
     */
    const requiredCalls: Array<{ label: string; pattern: RegExp }> = [
      { label: "grantSessionAuthorization", pattern: /\.grantSessionAuthorization\s*\(/ },
      {
        label: "grantScopeAuthorizationForToolCall",
        pattern: /\.grantScopeAuthorizationForToolCall\s*\(/,
      },
      { label: "sendSchedulerInstruction", pattern: /\.sendSchedulerInstruction\s*\(/ },
    ];

    for (const requiredCall of requiredCalls) {
      expect(
        requiredCall.pattern.test(sourceText),
        "GUI 的批准分支缺少 `" +
          requiredCall.label +
          "` 调用 —— 实测后果：批准返回成功、但任务停在 blocked、" +
          "工具从未执行、**产物不落盘**（用户目标「提交→授权→批准→落盘」的最后一环）。",
      ).toBe(true);
    }

    // 且必须是**唤醒指令**（不能只调 sendSchedulerInstruction 却发别的指令）
    expect(sourceText).toContain('action: "unblock"');
  });
});
