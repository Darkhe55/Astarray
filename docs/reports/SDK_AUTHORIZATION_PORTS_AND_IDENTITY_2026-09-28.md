# SDK 授权端口、身份绑定与主 Agent 实例身份（检查点 B，2026-09-28）

> 依据用户指令："补齐备份删除、安装交互端口及可信宿主用户上下文；缺端口或缺认证身份时，需要人工授权的操作不得放行，也不得无限等待。移除生产路径固定 \"sdk-user\"，并核查固定主 Agent 实例 ID。"

## 1. 修复前缺口

| # | 缺口 | 位置 |
| --- | --- | --- |
| 1 | SDK 硬编码 `backupDeletionControlPort: null` / `installationUserPort: null`，嵌入方无法提供交互授权通道 | `public-sdk.ts` |
| 2 | 固定身份 `"sdk-user"`（SDK）、`"cli-user"`（CLI bootstrap + 核心 `DirectDispatchController`）、默认 `"local-user"` | `public-sdk.ts` / `bootstrap.ts` / `commands.ts` / `application-runtime.ts` |
| 3 | 固定主 Agent 实例 ID `"main-agent-sdk"` / `"main-agent-cli"` / `"main-agent"`（违反"不可复用 agentInstanceId"） | 同上 |
| 4 | 缺身份时行为未定义（可用固定身份绕过"认证用户"来源校验） | 多处 |

## 2. 实现

1. 新增 `packages/core/src/core/host-user-context.ts`：`resolveHostUserIdentifier()` 取操作系统登录用户，解析不到返回 `null`。
2. `application-runtime.ts`：
   - 身份解析：**显式提供优先；`undefined` 取宿主用户；显式 `null` 保持 null**（不回落宿主，保证 fail-closed 有效）。新增 `authenticatedUserSource: "explicit" | "host" | "absent"`。
   - 主 Agent 实例身份：改为**由 state dir 绝对路径确定性派生** `main-<sha256(stateDir)[0:8]>` —— 同一会话（同一 state dir）跨进程复用，不同会话唯一，且不引入新的破坏性文件写入（不绕过 T3 架构守卫）。
   - `DirectDispatchController` / `ConversationTaskInsertionController` 的 `authenticatedUserId` 放宽为 `string | null`（比较式授权天然 fail-closed）；`InstallationGateGuard` 在**缺端口或缺身份**时立即拒绝（"无可信交互通道/缺少可信认证身份，安装被拒绝（fail-closed）"），不等待。
   - 无可信身份时**不注册**"认证用户"指导来源（该来源的指导提交不被受理）。
3. `public-sdk.ts`：公开选项 `authenticatedUserId` / `mainAgentInstanceId` / `backupDeletionControlPort` / `installationUserPort`（含公开类型导出）；`getRuntimeDiagnostics()` 扩展为端口存在性 + 身份来源 + 身份 + 主 Agent 实例 ID；新增 `requireAuthenticatedUserId()`：缺身份时需人工授权/归属的公共操作抛 `authenticated-user-required`（不等待）。
4. `bootstrap.ts` / `commands.ts`：改用宿主用户身份；不再使用 `"cli-user"`/`"main-agent-cli"`；不装配运行时的预算视图改用明确的**视图作用域键** `workset-status-view`（不再是伪 Agent 身份）。
5. 备份删除缺端口：既有行为即为立即 `tool-permission-denied` + 审计（本轮以诊断面与文档固化）。

## 3. 证据

- **红**：`tests/core/integration/sdk-authorization-ports-and-identity.test.ts` 首跑 4/4 失败（诊断字段不存在、身份仍为 sdk-user、实例 ID 相同、缺身份仍受理指导）。
- **绿（官方门禁，完整访问 + 默认 forks 池）**：构建成功；全量 **238 文件 / 1886 用例**；覆盖率 **93.12 / 85.5 / 93.34 / 93.14**；安全关键模块 **22/22**。
- **tarball 公开 SDK 入口验收**（`scripts/verify-sdk-default-path.mjs`）：默认路径独立反馈进程；诊断 `authenticatedUserSource: "host"`、`authenticatedUserId: <宿主用户>`（非 sdk-user）、`mainAgentInstanceId: "main-…"`（非 main-agent-sdk）、未注入端口时为 `false`；显式注入端口后为 `true` 且来源 `explicit`；`authenticatedUserId: null` 时 `submitRuntimeGuidance` 返回 `authenticated-user-required`（fail-closed）。
- 过程中修正两处自查问题：① 身份 `null` 曾被 `??` 回落成宿主用户（fail-closed 失效）；② 唯一化实例 ID 一度打断跨进程 CLI 摘要（改为会话级派生，`tests/tui/integration/summary-cli.test.ts` 恢复通过）。

## 4. 仍未做

- SDK `authenticatedUserId` 的**真实认证**（当前为宿主用户上下文/调用方声明，不做凭据校验）；GUI/服务端多用户场景需要接入真实认证结果。
- `backupDeletionControlPort` 在 SDK 侧仅提供通道装配；交互式实现仍由宿主（CLI `InteractiveBackupDeletionAuthorizationPort`）提供。
