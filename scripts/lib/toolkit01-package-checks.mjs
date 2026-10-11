/**
 * TOOLKIT-01-06 包级验收**判定逻辑**（纯函数，可单测）。
 *
 * 为什么单独成模块：内联判定曾导致"**零判据通过**"（本仓已有教训）。
 * 判定必须是可测试的不变量；任何**必需观测缺失** ⇒ 失败（fail-closed）。
 *
 * 输入是**观测结果**（由 verify-toolkit-package.mjs 从 tarball 隔离安装后的
 * 已安装包实测得出），输出是判据列表 `{ name, passed, detail }`。
 */

/** 安全读取嵌套观测值；缺失一律返回 undefined（由各判据自行 fail-closed）。 */
function readObservation(observation, sectionName, key) {
  if (observation === null || typeof observation !== "object") {
    return undefined;
  }
  const section = observation[sectionName];
  if (section === null || typeof section !== "object") {
    return undefined;
  }
  return section[key];
}

/** 读取数组观测；非数组一律按"未观测到"处理。 */
function readArray(observation, sectionName, key) {
  const value = readObservation(observation, sectionName, key);
  return Array.isArray(value) ? value : null;
}

/**
 * 构造包级验收判据。
 *
 * 纪律：`undefined`（未观测到）与 `false`（观测到不满足）**都判失败** ——
 * 绝不能因为"没测到"而放行。
 */
export function buildToolkitPackageChecks(observation) {
  const checks = [];
  const record = (name, passed, detail) => {
    checks.push({ name, passed: passed === true, detail });
  };

  /* ── 公开入口可达（包级消费的前提） ── */
  const entryNames = [
    ["RecipeExecutionEngine", "配方执行引擎"],
    ["createRecipeLifecycle", "配方生命周期"],
    ["ToolPackageRegistry", "工具包登记表"],
    ["ToolPackageVersionController", "版本控制器"],
    ["ToolPackageVersionStateStore", "版本状态持久化"],
    ["evaluateProgramToolEnablement", "程序工具隔离门禁"],
    ["DETERMINISTIC_CSV_TO_JSON_CONVERTER", "确定性转换器声明"],
    ["runDeterministicProgramTool", "受控执行入口"],
    // NODECTX-01（MERGE-01/NODECTX-01 同卡）：无损上下文与可见性展示必须同样可达。
    ["createLosslessContextManager", "无损上下文管理器"],
    ["buildContextVisibilityDisplayRows", "上下文可见性展示"],
    ["createLosslessContextManager", "无损上下文管理器（重启恢复）"],
  ];
  for (const [exportName, displayName] of entryNames) {
    const isPresent =
      readObservation(observation, "publicEntryExports", exportName) === true;
    record(
      "公开入口可达：" + displayName,
      isPresent,
      isPresent ? "已被隔离安装包导出" : "隔离安装包**未导出**该入口",
    );
  }

  /* ── 配方：定义校验与真实执行（"复用不是只 import"） ── */
  record(
    "配方定义校验生效（环/未知依赖/未声明工具被拒）",
    readObservation(observation, "recipe", "isDefinitionValid") === true,
    "需观测到合法定义通过校验",
  );
  const resolvedToolNames = readArray(observation, "recipe", "resolvedToolNames");
  const executedToolNames = readArray(observation, "recipe", "executedToolNames");
  const isEveryDeclaredToolExecuted =
    resolvedToolNames !== null &&
    executedToolNames !== null &&
    resolvedToolNames.length > 0 &&
    resolvedToolNames.every((toolName) => executedToolNames.includes(toolName));
  record(
    "复用不是只 import：验证期真实执行了全部声明工具",
    readObservation(observation, "recipe", "isReuseProvenNotImportOnly") === true &&
      isEveryDeclaredToolExecuted,
    isEveryDeclaredToolExecuted
      ? "声明工具均有真实执行记录"
      : "存在**只有 import、没有执行记录**的声明工具",
  );
  record(
    "配方执行成功并产出真实内容",
    readObservation(observation, "recipe", "isExecutionSuccessful") === true,
    "需观测到执行成功",
  );
  record(
    "独立验证：作者不能自验（自验被拒已记录）",
    readObservation(observation, "recipe", "rejectedSameAuthorValidation") === true &&
      readObservation(observation, "recipe", "validatorDiffersFromAuthor") === true,
    "需观测到自验被拒且验证者与作者不同",
  );

  /* ── 登记与作用域 ── */
  record(
    "只能按 ID+版本+哈希 寻址",
    readObservation(observation, "registry", "resolveByIdentityWorks") === true,
    "需观测到按身份寻址可用",
  );
  record(
    "名称不是路由键（按可读名称解析必须为 null）",
    readObservation(observation, "registry", "resolveByReadableNameIsNull") === true,
    "按名称解析**不得**命中（否则可被同名覆盖）",
  );
  record(
    "已启用内容不可原地修改（同 ID+版本 换哈希被拒）",
    readObservation(observation, "registry", "immutabilityEnforced") === true,
    "换哈希必须被拒并提示升版本",
  );
  record(
    "project 作用域在其它项目不可发现",
    readObservation(observation, "registry", "otherProjectCannotDiscover") === true,
    "推广不是跨项目写通行证",
  );
  record(
    "project 作用域在其它项目不可调用",
    readObservation(observation, "registry", "otherProjectCannotExecute") === true,
    "未在目标项目显式启用即不可调用",
  );

  /* ── 推广 ── */
  record(
    "推广候选剥离项目适配（去项目化）",
    readObservation(observation, "promotion", "candidateStripsProjectAdaptations") === true,
    "候选不得携带项目适配",
  );
  record(
    "推广候选拒绝敏感/项目内容（绝对路径/凭据/nonce/私有记忆）",
    readObservation(observation, "promotion", "sensitiveContentRejected") === true,
    "命中禁止内容必须拒绝",
  );
  record(
    "用户批准推广不自动在任何项目启用",
    readObservation(observation, "promotion", "approvalDoesNotEnableAnyProject") === true,
    "批准推广 ≠ 批准在所有项目运行",
  );

  /* ── 版本与回滚 ── */
  record(
    "新增副作用必须重新授权",
    readObservation(observation, "version", "reauthorizationRequiredForNewSideEffect") ===
      true,
    "含新增副作用的升级未授权必须被拒",
  );
  record(
    "重新授权门禁不可旁路（bypass 尝试被拒）",
    readObservation(observation, "version", "reauthorizationGateNotBypassable") === true,
    "不得存在「顺手传个标志」就绕过门禁的调用路径",
  );
  record(
    "回滚只切换后续版本、历史副作用保留",
    readObservation(observation, "version", "rollbackKeepsHistory") === true,
    "回滚不得撤销历史",
  );

  /* ── 隔离边界（§7） ── */
  record(
    "readOnly 自声明不构成信任（矛盾即拒）",
    readObservation(observation, "isolation", "readOnlySelfDeclarationNotTrusted") === true,
    "自声明只读但申请文件/进程/网络能力必须被拒",
  );
  record(
    "缺可强制执行沙箱必须拒绝",
    readObservation(observation, "isolation", "missingSandboxRejected") === true,
    "涉及文件/进程/网络缺沙箱必须拒",
  );
  record(
    "缺受控 broker 必须拒绝",
    readObservation(observation, "isolation", "missingBrokerRejected") === true,
    "涉及文件/进程/网络缺 broker 必须拒",
  );
  record(
    "平台不支持所需能力必须拒绝并报告不支持",
    readObservation(observation, "isolation", "unsupportedPlatformRejected") === true,
    "未支持环境明确拒绝",
  );
  record(
    "不提供任意脚本后备入口",
    readObservation(observation, "isolation", "arbitraryScriptFallbackDisallowed") === true,
    "首版不得增加任意脚本后备入口",
  );
  record(
    "被拒绝时保留工具配方路径",
    readObservation(observation, "isolation", "recipeFallbackPreserved") === true,
    "拒绝启用程序工具后配方路径仍可用",
  );

  /* ── 真实转换器 ── */
  record(
    "转换器通过隔离门禁后执行",
    readObservation(observation, "converter", "gatePassed") === true,
    "需观测到 isEnabledByGate=true",
  );
  record(
    "转换成功且输出符合预期",
    readObservation(observation, "converter", "conversionSucceeded") === true &&
      readObservation(observation, "converter", "outputIsExpected") === true,
    "输出必须与显式期望一致",
  );
  record(
    "坏行（列数不一致）明确失败",
    readObservation(observation, "converter", "badRowRejected") === true,
    "不得静默丢字段或补空值",
  );
  record(
    "确定性已验证（同输入同输出）",
    readObservation(observation, "converter", "determinismVerified") === true,
    "两次同输入必须逐字节相同",
  );


  /* ── NODECTX-01：无损上下文与"不把不在上下文显示成删除" ── */
  record(
    "NODECTX-01：可见性展示不得把「不在上下文」显示成删除",
    readObservation(observation, "losslessContext", "isPromptAbsenceShownAsDeletion") ===
      false &&
      readObservation(observation, "losslessContext", "isTextFreeOfDeletionWording") ===
        true &&
      readObservation(observation, "losslessContext", "isContentRetainedOnDisk") === true,
    "暂存/永久关闭的文案与字段都必须表明原文保留、可回访",
  );
  record(
    "NODECTX-01：无损暂存先写盘成功再改可见性（磁盘失败状态不变）",
    readObservation(observation, "losslessContext", "diskFailureKeepsStateUnchanged") === true,
    "写入失败时不得移出上下文、不得假报成功",
  );
  record(
    "NODECTX-01：工具调用与结果不拆散（配对同进同出）",
    readObservation(observation, "losslessContext", "toolPairIsAtomic") === true,
    "配对节点必须同进同出，单个暂存带调用标识即拒绝",
  );
  record(
    "NODECTX-01：暂存状态与原文必须能跨进程重启恢复（不得丢节点）",
    readObservation(observation, "losslessContext", "isStateRestoredAcrossRestart") === true &&
      readObservation(observation, "losslessContext", "isOriginalContentBytesIdenticalAfterRestart") ===
        true,
    "重启后可见性必须恢复为暂存、原文必须逐字节可读",
  );
  record(
    "NODECTX-01：待追认不被显示为已完成成果",
    readObservation(observation, "losslessContext", "pendingRatificationIsNotShownCompleted") ===
      true,
    "待追认必须带不确定标记（即便业务状态为 completed）",
  );

  return checks;
}
/** 汇总判定结果（`isPassed` 要求**至少一条判据**且全部通过）。 */
export function summarizeToolkitPackageChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const failedChecks = list.filter((check) => check.passed !== true);
  return {
    isPassed: list.length > 0 && failedChecks.length === 0,
    totalCheckCount: list.length,
    passedCheckCount: list.length - failedChecks.length,
    failedCheckNames: failedChecks.map((check) => check.name),
  };
}
