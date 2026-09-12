# E2E-01-02 切片 3：完成门禁与真实工具结果对账（缺口 2 修复）

> 检查点：E2E-01-02（状态仍为 **in_progress**；本切片修复已确认缺陷，未满足验收全部条款）
> 前驱：切片 2（docs/reports/E2E01_02_GAP_ANALYSIS.md，缺口 2）。日期：2026-09-10

## 1. 缺陷与修复

**缺陷（切片 2 探针确认）**：provider worker 的写操作失败（本例 `replaceFileContent` 因
assist 默认 `project.destructive-mutate=deny` 被拒/失败）后，模型仍可给出
`ASTARRAY_TASK_COMPLETION_V1`，本地完成门禁仅校验事件形态与任务标识，于是任务以 **done**
收口而**没有任何真实产物**——正是共同契约 §4 禁止的"字符串成功"。

**修复**（`packages/core/src/orchestration/worker-agent.ts`）：

- 定义会改变本地状态的工具集合 `MUTATING_TOOL_NAMES = {replaceFileContent, writeFileTemporary, backupVault, deleteBackup}`。
- 本轮跟踪 `unresolvedMutatingToolFailures`：某写工具失败即登记；同工具后续成功即清除。
- `runFinished(reason=success)` 时，除既有完成事件门禁外，若仍存在未解决的写操作失败，
  则以 `failure` 结案并给出可操作原因
  （"完成声明与本地工具结果不一致：<工具> 未成功（不得以文本声明结案）"），
  由调度层升级给用户裁决，而不是静默 done。

## 2. 证据（先红后绿）

`tests/core/integration/e2e01-provider-write-probe.test.ts`：

1. **未写入产物时不得声称完成（fail-closed）**：真实 provider 装配 + 本地协议服务器脚本化
   `replaceFileContent` → 任务状态 **blocked**，目标文件保持冻结桩
   `E2E01_TARGET_NOT_IMPLEMENTED`，服务器确实收到请求。
2. **写操作失败后任务链标记为 failed**：同一场景下 `status !== "done"` 且文件不变。

修复前该两例失败（status=done）；修复后 2/2 通过。既有只读工具循环回归
`tests/core/integration/provider-tool-loop.test.ts` 3/3 通过（未受影响：只读成功流程不受此门禁影响）。

## 3. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；174 文件 / 1494 用例通过 |
| `npm run test:coverage` | exit 0；174 文件 / 1494 用例通过；全局 93.73% stmts / **86.61% branch** / 91.61% funcs / 93.77% lines |
| 聚焦 | `e2e01-provider-write-probe` 2/2、`provider-tool-loop` 3/3、`worker-agent`/`worker-context-gate`/`context-runtime-wiring`/`recover-resume-execute` 无回归 |

## 4. 本检查点剩余

- **缺口 1（写入通道）**：assist 默认下 worker 仍无合法的工作区写入通道
  （`replaceFileContent`→destructive-mutate=deny；`writeFileTemporary` 仅临时目录）。
  需要受控"新建项目文件"通道或显式授权路径，属切片 3b。
- **缺口 3（纵向编排）**：侦察→规划→实现→测试→独立验收→返修→次级集成→主报告按需读取，
  以及三角色身份、强制返修、拒绝未授权合并、主报告不被抢占，属切片 4。
- 切片 5：tarball 隔离安装复现；E2E-01-03 真实 Provider 仍待凭据与费用授权。
