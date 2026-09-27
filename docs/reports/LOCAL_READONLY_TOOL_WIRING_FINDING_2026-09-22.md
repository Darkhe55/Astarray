# 本地只读工具接线缺口：注册了却永远失败（发现与修复，2026-09-22）

> 发现方式：继续审计"生产装配缺口"（承接敏感内容策略/账本与大小写能力的同类问题）。
> 状态：**已复现、已修复**。修复提交见 §4。

## 1. 症状

`searchProjectText` 与 `gitReadonlyView`（T06B / ADR-0014 的本地只读能力）是**已注册**的内置工具，且会被写入任务的工具集（`decomposePromptForScriptedRun` 取注册表全量工具名），但真实运行链路上调用它们恒失败：

```
错误(tool-execution-failed): searchProjectText 本地策略引擎未装配
```

## 2. 根因

| 位置 | 事实 |
| --- | --- |
| `packages/core/src/tools/builtins.ts:486-489, 507-510` | 两个工具在真实执行前要求 `executionContext.localToolPolicyEngine`，缺省直接抛错（fail-closed 设计） |
| `packages/core/src/tools/policy-wrapper.ts:74,76` vs `298-312` | 选项里有 `localToolPolicyEngine` / `ponderGitRepositoryPath`，但构造 builtins 上下文时**两项都没传** |
| `packages/core/src/application/application-runtime.ts:226`（修复前） | `new PermissionDecider(modeMachine, sessionManager)` 未传第三个参数（Ponder 只读判定器）→ `ponderReadonlyDecider === null` → **Ponder 下任何工具一律 deny** |
| 全仓 | 修复前 `new LocalToolPolicyEngine(...)` 在生产代码中 0 处出现 |

## 3. 修复

`application-runtime` 在实现受保护存储策略之后构造 `LocalToolPolicyEngine({ workspaceBoundary, protectedStoragePolicy })`，并：

1. 作为 `ponderReadonlyDecider` 注入 `PermissionDecider`（拒绝时返回 false → 稳定 `tool-permission-denied`，与既有语义一致）；
2. 通过 `PolicyWrapper` 选项透传 `localToolPolicyEngine` 与 `ponderGitRepositoryPath`（后者取工作区根），`policy-wrapper` 把它们写进 builtins 上下文。

## 4. 验证（红→绿 + 负控）

新增 `tests/core/integration/local-readonly-tools-production-wiring.test.ts`（3 例）：

1. **装配引擎后**：`searchProjectText` 经 `PolicyWrapper` 执行成功并返回命中内容（含文件名）；
2. **负控**：不装配引擎的同一调用仍报"本地策略引擎未装配"——证明第 1 例确实依赖真实注入，而不是恒真断言；
3. **真实运行装配**：`AstarrayApplicationFacade` + 本地假 Provider 的工具循环中，工具回填**不再**出现"本地策略引擎未装配"。

官方门禁（完整访问 + 默认 forks 池）：构建成功；全量 **232 文件 / 1869 用例**；覆盖率 **93.08 / 85.38 / 93.19 / 93.10**；安全关键模块 **22/22**。

## 5. 验证中发现的相邻事实（非缺陷，需知晓）

接线完成后，`searchProjectText` 在真实运行链路上仍**不会自动执行**：范围授权门禁先于工具执行介入，assist 返回 `auth-scope-awaiting-user-authorization`、devolve 返回 `auth-scope-awaiting-superior-approval`（"范围未知：必须人工裁决"）。这符合 GOV-02b/S6 的既定语义，但意味着：**本地只读工具当前没有任何自动放行路径**，需要认证用户/上级对精确操作授权后才能执行。

## 6. 残留

- Ponder 仍不暴露工具：`respondInPonderMode` 固定 `availableToolDescriptors: []`、系统提示"纯问答，不调用任何工具"，因此 `PONDER_READONLY_TOOL_NAMES` 在当前产品形态下不可达。若 ADR-0014 要求 Ponder 支持只读工具执行，需要独立设计检查点（涉及提示、工具暴露、permission decider 与 UI 反馈）。
- `gitReadonlyView` 本次未做端到端执行验证（需要真实 git 仓库与授权路径）；其接线与 `searchProjectText` 共用同一引擎，已由第 1/2 例覆盖引擎本身。
