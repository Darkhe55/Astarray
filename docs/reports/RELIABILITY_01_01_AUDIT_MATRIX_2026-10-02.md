# RELIABILITY-01-01 审计矩阵（2026-10-02）

> 任务卡：《2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY_TASK_CARDS》§5 RELIABILITY-01。
> 检查点产出要求：**全量工具/入口清单、调用链与风险矩阵；每项标"已证实/失败/未验证"及文件与测试引用；
> 先检查卡内点名的静态疑点**。本文件是审计结果，不构成"可靠性要求已满足"。

## 0. 基线与纪律

| 项 | 值 |
| --- | --- |
| commit | `f46a218`（审计开始）→ 本轮修复后新提交 |
| dirty | 用户并行改动（README/docs/IMPLEMENTATION_PLAN/PLAN_STATUS 等）**未触碰、未暂存** |
| 平台 | Windows（本机）。Linux/macOS **未验证** |
| 真实额度 | **0**（全部走离线 fixture / 假服务） |

## 1. 静态疑点核查（卡内点名 4 项）

### 疑点 1：`recovery-classification-service.ts` 尾部分支返回 bounded-retry — **确认缺陷，已修**

- **缺陷**：`confirmed-success` 且 `isIdempotent=false` 时，前两个 `if` 都不命中，落到尾部分支 →
  返回 `bounded-retry` → **对已确认成功的非幂等操作给出"可重试"分类**（重复副作用风险）。
- **修复**（`packages/core/src/orchestration/recovery-classification-service.ts`）：
  1. `confirmed-success` **一律** `reuse-confirmed-result`（与幂等性无关）；
  2. `confirmed-failure` 且预算为 0 → 明确 `blocked-uncertain-side-effect`（不再给可重试分类）；
  3. 非幂等 `result-unknown` → 仍 `blocked-uncertain-side-effect`（语义不变）。
- **反例**（先红后绿）：`tests/core/integration/reliability-recovery-classification.test.ts`（5 条）
  - 修复前 3/5 红（①②⑤）；修复后 5/5 绿；既有 `recovery-classification`(8) + `fault-injection-recovery`(8) 无回归。
- **调用方**：`recovery-center-controller.ts:313`、`fault-injection-recovery-verifier.ts:60`（均通过本服务分类，无旁路）。

### 疑点 2：`public-sdk.ts` 会话内 idempotencyKey — **三个缺口（未修，属 RELIABILITY-01-02/03）**

| 缺口 | 证据 | 影响 |
| --- | --- | --- |
| **并发窗口** | `submitTask` 是"先查 `taskIdentifierByIdempotencyKey` → 再 `await handleUserMessage` → 才写入"（`public-sdk.ts:2242-2295`），检查与登记之间存在 `await` | 同会话同 key 并发提交可**双执行**（非原子 claim） |
| **不持久化** | `taskIdentifierByIdempotencyKey` / `tasksByTaskIdentifier` 为进程内 `Map` | 重启后同 key 重复提交会**再次执行**；不满足"重启重放"要求 |
| **同键异参未拒绝** | 命中 key 时直接 `return this.toTaskResult(existingTaskIdentifier, …)`，不比较 prompt/参数 | 卡内明确要求"**同键异参拒绝**"，当前静默复用旧结果 |

- 卡内要求"名称存在不证明 exactly-once"——本项**不作 exactly-once 承诺**，按缺口登记。
- 未写反例（属检查点 02 的"可复现行为反例"范围）。

### 疑点 3：`git-process.ts` 超时与子进程收口 — **部分已证实，一处风险**

| 项 | 结论 |
| --- | --- |
| 超时即 kill | ✅ `childProcess.kill("SIGKILL")`（`git-process.ts:88-91`） |
| 退出确认 | ✅ 在 `close` 事件里才 reject（等待真正退出、释放句柄）（`:96-107`） |
| 超时 ≠ 操作失败 | ✅ 超时抛**普通 Error**（非 `GitProcessError`），与"非零退出"区分 |
| **子进程树** | ⚠️ 用 `SIGKILL` 杀单个进程；**未做进程树/进程组收口**。git 可能派生远端传输子进程（如 `git-remote-https`），其句柄可能残留。**未验证** |
| **调用方对"未知"的处置** | ⚠️ `git-integration-coordinator.ts:304-316`：`checkout` 后 `merge`，并把 `checkout --detach` 的失败 `.catch(() => {})` **静默吞掉**；merge 超时异常向上抛，但**未见对"合并是否已生效"的对账** → 结果未知未走对账路径 |

- 该调用方的对账缺口列入 01-02 返修候选（**不**在本检查点改运行循环）。

### 疑点 4：注册工具清单 — **已枚举（见 §2）**

## 2. 全量工具清单与风险分类（11 个内置工具）

| 工具 | category | mutationKind | 备份策略 | 幂等性判定 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `readFile` | readonly | none | not-required | 只读 | 已证实（`builtins.ts:79`，测试：`tests/core/integration/provider-tool-loop.test.ts`） |
| `listDirectory` | readonly | none | not-required | 只读 | 已证实（`:96`） |
| `searchProjectText` | readonly | none | not-required | 只读 | 已证实（`:198`） |
| `gitReadonlyView` | readonly | none | not-required | 只读（固定 enum，不经 shell） | 已证实（`:211`） |
| `taskSequenceStatus` | readonly | none | not-required | 只读 | 已证实（`:185`） |
| `factVerification` | restricted | none | not-required | 只写证据文件（**追加式**，需按参数身份去重） | **未验证**（无专项幂等反例） |
| `writeFileTemporary` | restricted | create-only | not-required | **条件幂等**：目标已存在即拒（`EEXIST` → 无副作用） | 已证实（`SideEffectNoneError`；`scope-reservation-settlement` 等） |
| `createProjectFile` | restricted | create-only | not-required | 同上 | 已证实（同上 + `artifact-presence-cli.test.ts`） |
| `replaceFileContent` | restricted | overwrite | automatic-preimage | **非幂等**（每次覆盖内容不同）；有 pre-image 备份 | 部分证实（备份路径有测试；**重试边界未验证**） |
| `backupVault` | restricted | none（`restore` 动作实为写） | not-required | 读=幂等；**`restore` 非幂等**（覆盖当前文件） | **未验证**（`restore` 的重试/对账） |
| `deleteBackup` | restricted | delete-protected-backup | protected-vault-deletion | **非幂等**（删除不可逆） | 部分证实（两阶段/nonce 有测试 `auth-scope-install-routing` 等） |

> 幂等性结论来源：`mutationKind` + 实现语义（`builtins.ts`）。**不得**把所有写工具标为可重试——
> 上表中 `replaceFileContent`/`backupVault(restore)`/`deleteBackup` 均属非幂等。

## 3. 入口清单与调用链

| 入口 | 位置 | 调用链要点 | 状态 |
| --- | --- | --- | --- |
| CLI `run` | `packages/tui/src/cli/run-command.ts` | → SDK `submitTask` → MainController → MissionOrchestrator → WorkerAgent → `ScopeGatedToolPort` → `PolicyWrapper` → builtins；权限询问经 `permission-ask-adjudication.ts` | 已证实（含 `artifact-presence-cli` / `permission-ask-timing` 端到端） |
| CLI 其他命令 | `packages/tui/src/cli.tsx` | provider/config/profile/recover/doctor 等，多数为状态目录读写 | 部分验证 |
| TUI | `packages/tui/src/ui/**` | 经同一 SDK/控制器 | **未验证**（本轮未覆盖） |
| GUI | `packages/gui/**` + `gui-server` | 经 SDK | **未验证** |
| MCP | `mcp-stdio-server` / `mcp-tool-bridge` | 工具桥接 | **未验证** |
| SDK | `packages/core/src/public-sdk.ts` | `submitTask`（含 idempotencyKey，见疑点 2）、`queryTask`、`resume` 等 | 部分证实 |
| 调度派发 | `mission-orchestrator.ts` | 任务链、worker 工厂、失败阈值 | 已证实（多测试） |
| Provider | `packages/core/src/runtime/*` | 流式解析、工具循环、完成协议 | 已证实（`provider-tool-loop` 等） |
| 反馈进程 | `feedback-process-*` | 独立子进程 + journal ack | 部分证实（`feedback-process-default-path`） |
| 恢复 | `recovery-center-controller.ts` 等 | 检查点 + 分类服务 | 已证实（本轮修复后 21/21） |
| 工作时段门禁（WORKWINDOW） | **尚未实现**（卡内后置） | — | 未实现 |

## 4. 风险矩阵（按"副作用与幂等性 / 操作身份 / 去重原子性 / 重试边界 / 超时与取消 / 恢复所有权 / 结果状态 / 资源公平"）

| 维度 | 现状 | 缺口/风险 | 状态 |
| --- | --- | --- | --- |
| 副作用与幂等性 | 工具按 `mutationKind` 分类；**已补工具级 `isIdempotent` 元数据（R1，2026-10-02）**；`isSideEffectFree` 仅成功时返回 | `isIdempotent` 由工具实现方声明（缺失视为 `false` 保守）；恢复分类不再依赖调用方猜测 | **已修复**（R1，`recovery-classification-service` + `ToolDescriptor`） |
| 操作身份 | 逻辑操作指纹 = 工具+路径+完整规范化参数（本轮前序工作） | `operationId` 与 `attemptId` 未在工具层显式分离 | 部分 |
| 去重原子性 | 作用域门禁有"执行前原子预留"（同步段内建立） | SDK `submitTask` 的 idempotencyKey **非原子且不持久**（疑点 2） | **失败** |
| 重试边界 | `ToolFailureCounter` 阈值 + recovery 预算 | 嵌套重试（工具内 + 任务级）是否有乘法膨胀 **未验证** | 未验证 |
| 超时与取消 | git 超时区分"超时 vs 非零退出"；提供商请求超时可配 | **R2 实测（Windows）：孙进程已被系统收口**（夹具活性 + 心跳停止双证）；**POSIX 未验证**。**R3 已修**：merge 失败/超时改为只读对账并记入未决风险；`checkout --detach` 失败不再静默吞掉 | Windows 已证实 / POSIX 未验证 |
| 恢复和并发所有权 | 检查点 + epoch/租约存在（T12A） | 旧 epoch 调用失效的**动态证据未覆盖** | 未验证 |
| 结果状态 | 已确认成功不重复（本轮修复后） | `confirm` 丢失、部分副作用场景未注入 | 部分 |
| 资源与公平性 | 等待用户/网络不持锁（设计如此） | 锁序、背压、暂停原因隔离 **未验证** | 未验证 |

## 5. 下一步返修建议（供 RELIABILITY-01-02 使用，按依赖排序）

1. **R1（小，先做）**：为 11 个工具补 `isIdempotent` 元数据（由 `mutationKind` + 实现语义推导），
   让恢复分类不再依赖调用方判断；补 `planned/started + 非幂等` 的分类反例。
   → **已完成（2026-10-02）**：`ToolDescriptor.isIdempotent` + 11 个内置工具取值 +
   `planned/started + 非幂等 → blocked-uncertain-side-effect`；反例 ⑥⑦ 覆盖。
2. **R2（小）**：`git-process` 超时按**进程组**收口（POSIX `detached`+`process.kill(-pid)`；
   Windows 用 `taskkill /T`），并补"子进程残留"反例。
   → **Windows 实测无需修改**（2026-10-02）：`tests/core/integration/reliability-git-process-tree.test.ts`
   用"父进程派生的孙进程写心跳"夹具验证；`⓪` 证明孙进程确实在写（>3 次心跳），
   `①` 证明超时后心跳停止增长 → 该平台上进程树已随父进程收口。**POSIX 未验证**（保留为跨平台风险项）。
3. **R3（中）**：`git-integration-coordinator` 的 merge/checkout 失败路径改为**显式对账**
   （查询 HEAD/分支状态判定"合并是否已生效"），去掉 `.catch(() => {})` 静默吞错。
   → **已完成（2026-10-02）**：新增只读对账 `settleTargetBranchMerge`（`rev-parse` +
   `merge-base --is-ancestor`，结果区分 merged/not-merged/unknown），merge 失败/超时记入
   `unresolvedRisks`；`checkout --detach` 失败同样记入。反例 3 条（①② 修复前红）。
4. **R4（中）**：SDK `submitTask` 的 idempotencyKey 改为**原子 claim + 持久化 + 同键异参拒绝**；
   补并发同键、重启同键、异参反例。
5. **R5（中）**：故障注入矩阵（卡内 §"故障注入矩阵"）落到 01-02：派发前/已持久化未执行/执行中/
   副作用完成但回执未写/回执写入但确认丢失/恢复过程中，六个时点 × 代表操作。

## 6. 验收与限制

- 本检查点**只**产出审计矩阵与 1 项最小修复（疑点 1）。**不**宣称"可靠性要求已满足"。
- 门禁：`npm run check`（真实退出码见提交说明）；未验证项已逐条标注，不得视为通过。
- Linux/macOS 未实测，保留未验证。
