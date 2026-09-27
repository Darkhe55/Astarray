# 思索模式只读白名单工具未接通（规则冲突修复，2026-09-22）

> 依据：AGENTS.md —— "思索模式只允许本地只读白名单工具查看项目文件、检索文本和查询只读任务状态；编辑、进程执行、网络访问、备份访问及任何未知或副作用不明确的工具必须由本地 harness 直接禁用，不能仅靠提示词约束。"
> 状态：**已复现、已修复**。

## 1. 症状（修复前）

`respondInPonderMode` 固定：

```ts
systemPrompt: "你是主 Agent（Ponder 模式）：纯问答，不调用任何工具。"
availableToolDescriptors: [],
maxLoopIterations: 1,
```

即思索模式**完全不暴露** `PONDER_READONLY_TOOL_NAMES`（readFile / listDirectory / searchProjectText / taskSequenceStatus / gitReadonlyView），且不接工具循环——规则不成立（也谈不上"由本地 harness 直接禁用"，因为所有工具都被禁用）。

## 2. 修复

1. `MainControllerOptions` 新增 `ponderReadonlyToolingFactory(agentInstanceId) → { toolDescriptors, toolPort }`；`respondInPonderMode` 据此暴露白名单描述符并改用 `runToolLoop`（迭代上限取 `maxLoopIterations`，至少 2），系统提示改为"可调用本地只读白名单工具……禁止写入/执行/网络/备份等"。未装配工厂时保持纯问答（向后兼容）。
2. `application-runtime` 抽出 `createPolicyWrapperForAgent`（worker 任务端口与思索模式端口**共用同一套安全端口**：受保护存储、敏感内容策略、读取账本、本地策略引擎、安装门禁、证据包），思索模式端口只放行 `PONDER_READONLY_TOOL_NAMES ∩ 注册表`。
3. **关键点**：思索模式端口**不得**使用可配置权限组引擎。Ponder 内置 profile 全项 deny 且不可调整（源码注释即写"白名单由执行层覆盖"），若走 profile 引擎会短路执行层白名单；因此该端口把 `configurablePermissionPolicyEngine` / `currentPermissionProfileReference` 置空，回退 `PermissionDecider`（模式矩阵 + `LocalToolPolicyEngine`），白名单外工具 fail-closed。

## 3. 验证（红→绿）

新增 `tests/core/integration/ponder-readonly-tools-production-wiring.test.ts`（2 例，走公共入口 `handleUserMessage` + 本地假 Provider）：

1. **正向**：首轮请求的工具列表**恰好**是 5 个只读白名单工具、不含 `writeFileTemporary`；模型调用 `readFile` 后，正文**真实执行并回填**进下一轮请求（含 fixture 内容）。
2. **拒绝**：模型调用白名单外的 `writeFileTemporary` → 工具结果为 `tool-permission-denied`（fail-closed）。

**红**：修复前 2 failed（首轮请求工具列表为空、无工具执行）。**绿**：2/2。官方门禁（完整访问 + 默认 forks 池）：构建成功；全量 **234 文件 / 1874 用例**；覆盖率 **93.14 / 85.46 / 93.33 / 93.16**；安全关键模块 **22/22**。CLI 端到端仍正常：`run --mode ponder --runtime mock --json` → `{mode:"ponder",status:"done",answer,...}`，退出码 0。

## 4. 边界与残留

- 思索模式只读端口**不经过**范围授权门禁（AUTH-SCOPE）：这是刻意的——思索模式白名单是本地确定性只读能力，不产生项目外/安装类副作用；其余工具连暴露都不暴露。
- `searchProjectText` / `gitReadonlyView` 在思索模式下的执行仍受本地策略引擎与受保护存储/敏感路径过滤约束；本轮未对二者做端到端命中验证（需要真实检索/仓库场景），其派发拒绝路径已被第 2 例覆盖。
- 第 93 轮记录的"本地只读工具无自动放行路径"仅指**次级 Agent** 路径（范围未知需人工裁决）；思索模式主 Agent 路径已按规则本地放行。
