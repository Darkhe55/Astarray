# E2E-01-04 收口：最后一个 `it.skip` 已修复（2026-10-10）

> 范围：`tests/tui/integration/cli-anthropic-protocol.test.ts` ①（此前仓库**唯一**的 `it.skip`）。
> 结论：**已定位真因、已修复、已转绿（`skipped` 1 → 0）**。本节点**已无本地可修的已知阻塞**。
> 仍缺（只能由用户/平台提供，如实保留 `in_progress`）：**人工体验结论**、**Linux/macOS 平台证据**。

## 1. 基线与结果（真实退出码）

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| `npx vitest run tests/tui/integration/cli-anthropic-protocol.test.ts` | **exit 1**，`AssertionError: expected 'blocked' to be 'done'`，**31.2s** | **exit 0**，**0.85s** |
| CLI 结果 JSON | `status: "blocked"`、`permissionAsk: "requires-human-resubmission"` | `status: "done"`、`permissionAsk: "allowed-once"` |
| 产物 `.tmp/ANTHROPIC.md` | **不存在** | 存在，内容逐字等于 `"# ANTHROPIC\n"` |
| 工具结果序列（探针实测） | `permission-ask-pending` → `auth-scope-replay-rejected × 6` | 授权后一次真实执行成功 |
| 全量门禁 `npm run check` | — | **exit 0**，**308 文件 / 2352 用例通过、skipped 0** |
| `npm run test:coverage`（阈值 85） | — | **exit 0**，行/分支/函数/语句 **92.66 / 85.05 / 92.62 / 92.7**（与上轮持平，无回归） |

## 2. 被证伪的假设（**先记下来，避免下一轮重走**）

交接文档与 `PLAN_STATUS.md` 当时给出的首选方向是"**谁先消费了 stdin**"。

**实测证伪**：在 `createStdinLineReader()` 创建处与每次 `data`/`end` 打临时 stderr 痕迹后单跑，
得到：

```text
[STDIN-TRACE] created isTTY=undefined
[STDIN-TRACE] data len=11 value="allow-once\n"
[STDIN-TRACE] end
```

裁决输入**正常到达**。因此：

- `createStdinLineReader()` 的行读取器**不需要改动**（其跨 chunk 缓存/`end` flush 逻辑本来就是对的）；
- `bootstrap.ts` 的 TTY-only 口径、`hasInputChannel()` 的判定**都不是原因**；
- `run-command.ts` 的 `if (decision !== "allowed-once") break;` **不是**本次的触发点（这次 `decision` 确实是 `allowed-once`）。

**方法论结论**：把痕迹打在**门禁的状态变更点**（授权登记 / 消费 / 预留 / 结算），而不是继续推测读取器。

## 3. 真实根因（两层，都在装配顺序上）

装配顺序是 `ScopeGatedToolPort(PolicyWrapper(...))`——**范围门禁在外、权限引擎在内**。

### 3.1 第一层：被"从未执行的拒绝"永久烧掉的范围授权

时序（门禁痕迹实测 `fp` 同一逻辑操作）：

1. 第 1 次调用：范围门禁 `authorizeForExecution` 授权并**消费**该操作的范围记录
   （记录是**本轮新建**的，`consumedAtIso=nowIso`），随后建立预留；
2. 内层 `PolicyWrapper` 判 `ask` → `permission-ask-pending`（**工具从未执行**）；
3. 预留按"确定无副作用"结算为 `released`——但它只恢复了 `armedAuthorization`
   （"逻辑操作授权快照"，**范围裁决路径下本来就不存在**）⇒ **范围记录仍停在已消费**；
4. 随后每一次重跑：无逻辑授权 → 只读预演为 `allow` → `authorizeForExecution` 命中
   `consumedAtIso !== null` ⇒ **`auth-scope-replay-rejected`**（实测 6 连拒），
   任务在 `MAXIMUM_ADJUDICATION_ROUNDS` 内以 `blocked` 收口。

**用户的 `allow-once` 也无法挽救**：授权确实登记了（stderr 有"作用域授权: granted"），
但重跑在读**范围记录**这一步就已被判重放并短路。

**修复**（`packages/core/src/tools/scope-authorization-gate.ts`）：

- `ExecutionReservation` 新增 `authorizedScopeFingerprint`：把**本次预留消费掉的范围记录指纹**
  挂到预留上（`reserveForExecution` 走 `performScopeAuthorization` 拿到 `operationFingerprint`）；
- 仅在 `sideEffectStatus === "none"`（**确定未执行、无副作用**）的释放路径调用
  `restoreConsumedScopeRecord()`：把该记录的 `consumedAtIso` 清回 `null`；
- `restoreConsumedScopeRecord()` **只清回消费标记**：不改写裁决内容、不新增记录、不跨 revision 放宽；
- `performScopeAuthorization()` 是 `authorizeForExecution()` 的私有核心，公共方法**只返回**
  `ScopeGateOutcome`（不把内部指纹暴露给调用方），对外签名与行为不变。

**重放保护不放宽**：真正执行**成功**后该记录仍停在已消费，同一逻辑操作再次调用仍被判 `replay-rejected`
（既有断言 `scope-consumption-semantics` ②、`scope-authorization-regrant` 仍全绿）。

### 3.2 第二层：父目录不存在导致工具失败

授权打通后，重跑**确实进了真实工具**，但内层返回：

```text
错误(tool-execution-failed): ENOENT: no such file or directory, open '…\.tmp\ANTHROPIC.md'
```

需求文本是"创建 `.tmp/ANTHROPIC.md`"，而 `.tmp/` 尚不存在；
`createProjectFile` 直接以 `wx` 打开目标文件 ⇒ `ENOENT`（且此失败会按"结果未知"进入对账）。

**修复**（`packages/core/src/tools/builtins.ts`）：补建父目录（`mkdir(..., { recursive: true })`，幂等、
不覆盖任何文件）后**仍以 `wx` 排他创建**——"仅新建、不覆盖"语义不变，目标已存在时依旧报
`拒绝覆盖已存在文件`（`SideEffectNoneError`）。

## 4. 回归反例（先红后绿，均已留在仓库）

| 文件 | 反例 | 红→绿证据 |
| --- | --- | --- |
| `tests/core/integration/permission-refusal-side-effect.test.ts` | ③ 范围门禁先消费、内层权限引擎再 ask：用户裁决后重跑必须能执行（不得 replay-rejected）；④ 无重新登记时必须仍 fail-closed | ③ 在修复前失败于 `auth-scope-replay-rejected`；④ 守住不放宽 |
| `tests/core/unit/builtins.test.ts` | `createProjectFile` 自动补建不存在的父目录后完成排他创建 / 已存在文件仍拒绝覆盖 | 前者修复前 `ENOENT`；后者始终守住语义 |

`tests/tui/integration/cli-anthropic-protocol.test.ts` ① 已由 `it.skip` 改回 `it`，
并把过时诊断注释替换为**结案说明 + 真因记录**（不删除反例）。

## 5. 诊断纪律

- 临时痕迹（`[STDIN-TRACE]` / `[GATE#…]` / `[ENGINE-TRACE]`）**只用于定位**，验证后已**全部移除**，
  提交内不含任何 TRACE 代码（`git diff` 可复核）。
- 改 `src` 后一律**先 `npm run build`**，再跑由 `dist/` 驱动的用例（该用例 spawn `dist/cli.js`）。
- 本轮未打印、未写入任何凭据（探针只用环境变量 `ASTARRAY_PROVIDER_API_KEY=test-key` 的假值）。
