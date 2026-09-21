# 安全接线缺口：敏感内容禁读与读取时间锁在生产路径未装配（发现，2026-09-21）

> 发现方式：核查 LINUX-PORT-01 残留项时，追踪"谁在生产中构造敏感内容策略"而发现。
> 状态：**已核实、未修改生产行为**。修复会改变用户可见行为，需显式决定（见 §5）。
> 影响等级：**高** —— ADR-0018 的凭据/敏感文件禁读与 ADR-0017 的重复读取时间锁在当前产品路径上**均未生效**。

## 1. 结论

`SensitiveContentAccessPolicy`（T06C / ADR-0018）与 `ReadSuppressionLedger`（T07B / ADR-0017）在 `packages/` 内**没有任何生产构造点**；唯一的生产工具执行入口 `PolicyWrapper` 在构造 builtins 上下文时**不传**这两个字段，而 builtins 的两个守卫在字段缺省时**直接放行**。因此：

- 模型经文件工具读取 `.env`、`.env.*`、私钥、凭据库或管理员扩展敏感路径时，**不会**被拒绝，也不会做内容 DLP 扫描；
- 同一调用源在窗口内重复读取未变化资源时，**不会**触发 `resource-already-read` 时间锁。

## 2. 证据（逐处 file:line）

| 位置 | 事实 |
| --- | --- |
| `packages/core/src/tools/builtins.ts:803-816` | `assertSensitiveContentAllowed`：`sensitivePolicy === null/undefined` → `return`（注释明示"未装配策略时放行（装配方负责注入）"） |
| `packages/core/src/tools/builtins.ts:822-831` | `assertNotAlreadyRead`：`ledger` 缺省 → `return` |
| `packages/core/src/tools/builtins.ts:852-862` | `registerReadForSuppression`：`ledger` 缺省 → `return`（连登记都不做） |
| `packages/core/src/tools/policy-wrapper.ts:286-297` | 生产 builtins 上下文只传 `workspaceBoundary / temporaryDirectoryPath / requestingAgentInstanceId / backupServicePort / vault / deletionController / protectedStoragePolicy / taskSequenceStatusController`——**没有** `sensitiveContentAccessPolicy`、`readSuppressionLedger` |
| `packages/core/src/application/application-runtime.ts:679-697` | **唯一**的 `new PolicyWrapper({...})` 生产构造点（`buildWorkerToolPort`），入参同样不含上述两项 |
| 全仓 grep | `new SensitiveContentAccessPolicy` / `new ReadSuppressionLedger` 在 `packages/` 内 **0 命中**（仅测试构造） |
| `packages/core/src/application/application-runtime.ts:475-480` | 侦察路径的敏感判定用的是**内联子串启发式** `filePath.includes(".env") \|\| filePath.includes("credential")`，并非真实策略 |

## 3. 对照规范

- **ADR-0018**："`.env`、`.env.*`、私钥、凭据库和本地敏感路径在思索、协同、放权三种模式下都禁止模型读取；该禁令由本地路径/内容策略在打开或返回内容前执行，模式升级、会话授权和模型声明均不能绕过。"——当前生产路径未执行该禁令。
- **AGENTS.md**：同一禁令为强制条款；`T06C` 卡片据此判为 done。
- **ADR-0017 / T07B**：重复读取时间锁与活锁保护依赖该账本。

## 4. 为什么测试全绿

单元与集成测试都**自行构造**策略/账本并显式放进 fake 上下文（例如 `tests/core/unit/read-suppression-and-guard.test.ts` 的 `buildReadContext`），因此覆盖的是"装配后行为"；**没有任何测试断言生产装配点真的把它们传下去**。这正是本目标强调的"公共入口真实调用控制器/产物状态"缺口：测试绿 ≠ 产品接线完整。

## 5. 建议修复（需决定；本轮未改生产行为）

1. `PolicyWrapper` 选项新增 `sensitiveContentAccessPolicy`、`readSuppressionLedger`（可选，缺省仍为 null 以保持既有测试语义），并在 builtins 上下文中透传；
2. `application-runtime` 构造两者并注入（大小写能力复用已有探测 `detectFileSystemCaseSensitivity`，同时消除 LINUX-PORT-01 记录的 macOS 残留）；
3. 侦察路径的内联子串启发式改为复用真实策略端口，避免两套判定；
4. 行为反例（先红后绿）：生产路径集成测试——经 `PolicyWrapper` 调 `readFile(".env")` 必须 `sensitive-content-read-denied`；同源重复读取必须 `resource-already-read`；并加一条**装配守卫测试**（若 `application-runtime` 不再注入则失败），防止再次静默失效；
5. 预期连带影响：现有经生产路径读取 `.env`/敏感命名文件的测试与 fixture 需改为期望拒绝；需逐项核对 E2E-01 mock 流程与 TUI/CLI 命令测试；
6. 门禁：`npm run check`、`vitest run --coverage`、`verify:security-coverage`（`sensitive-content-access-policy`、`read-suppression-ledger`、`policy-wrapper` 均在 22 个 ≥95% 分支清单内）。

## 6. 本轮未做

未修改任何生产代码或测试期望；仅记录证据与修复方案。修复因涉及用户可见行为（原本可读的敏感文件将变为拒绝读取）与较大测试面，等待明确决定后作为独立检查点执行。
