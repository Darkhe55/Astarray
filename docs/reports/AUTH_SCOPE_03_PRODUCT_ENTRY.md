# AUTH-SCOPE-03 执行前门禁与公共入口 — 证据

> 检查点：AUTH-SCOPE-03（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md，未跟踪用户文件）
> 前驱：AUTH-SCOPE-02（提交 `85456a8`，本地未推送）。日期：2026-09-16
> 契约补充：docs/adr/0039-auth-scope-and-adjudication-matrix.md §17–23

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/tools/scope-authorization-gate.ts`（新） | `ScopeAuthorizationGate`（preview/authorize/grantUserAuthorization/listDecisionRecords/recheckReceipt）、`describeToolOperation`（工具→操作）、`ScopeGatedToolPort`（未授权不触达内层工具） |
| `packages/core/src/application/application-runtime.ts`（扩展） | 显式登记工程根（`workspaceRootPath`/`projectIdentifier`，`WorkspaceBoundary` 与范围判定同源，不再隐式 cwd）；构造门禁并包裹 Worker 工具端口；暴露 `registeredProjectRoots`/`scopeAuthorizationGate` |
| `packages/core/src/public-sdk.ts`（扩展） | `listRegisteredProjectRoots`、`evaluateOperationScope`（只读预演）、`grantScopeAuthorization`（单次授权）、`queryScopeAuthorizations` |
| `tests/core/integration/auth-scope-gate.test.ts`（新，10 用例） | 放权无等待、协同上级批准、项目外等待人工、单次授权与重放、过期授权、deny 优先、思索只读、未知/安装、预演无副作用、运行时接线 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 放权模式项目内操作仍等待人工 | 无人工等待 | ✅ `allow`、裁决者为本地策略、**上级端口 0 次调用** |
| 协同项目内操作无人批准即执行 | 上级批准后执行并留回执 | ✅ 上级端口被调用一次，回执 `adjudicator=superior-agent` 且已消费 |
| 协同项目外操作直接执行 | 等待认证用户 | ✅ `auth-scope-awaiting-user-authorization`（S3），上级端口 0 次调用 |
| 同一授权可重复使用（重放产生副作用） | 单次使用 + 重放拒绝 | ✅ 首次成功、第二次 `auth-scope-replay-rejected`，内层工具执行次数 = 1 |
| 过期授权仍可用 | 拒绝 | ✅ `auth-scope-authorization-expired` |
| deny 被模式/范围覆盖 | deny 优先且不执行 | ✅ 三模式下 `auth-scope-denied`，内层工具 0 次 |
| 思索模式可写 | 只读放行、写入拒绝 | ✅ 读 `allow`、写 `auth-scope-denied` |
| 未知范围或安装关闭仍放行 | 人工/开关约束 | ✅ S4 → await-user；安装关闭 → denied；开关开启 + 协同 → await-user |
| 预演消耗授权 | 只读预演 | ✅ `previewDecision` 返回 `ask-superior` 且 `listDecisionRecords()` 为空 |
| 范围判定仍读 cwd | 使用登记工程根 | ✅ 运行时登记根 = 显式临时目录（≠ cwd）；根内 → S1/"P"、根外 → S3/ask-user；公共入口授权指纹一致 |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run`（auth-scope 两套件） | 0；**19 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| 全量门禁与推送 | 见 §5 |

## 4. 已知影响面

- Worker 工具端口现在统一经过范围门禁：项目内写入在协同模式由本地上级自动批准（留回执），
  放权模式默认放行，思索模式写入拒绝；跨根/项目外/未知/安装需要人工，**不再依赖 cwd**。
- 既有安装门禁与专用流程（备份删除/远端发布）保持原样，未被放宽。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run build` | **exit 0** |
| `npx vitest run --maxWorkers=6` | **exit 0：206 文件 / 1669 用例全通过** |
| `npx vitest run --coverage --maxWorkers=6` | **exit 0**：全局 statements **93.25%** / branch **85.48%** / functions **92.21%** / lines **93.31%**；`packages/core/src/tools` 目录 **95.32% / 90.42% / 96.90% / 95.32%** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| `git push` | **exit 0**（网络自上一阶段重置后恢复）：`864b300..40df2ed` 已推送上游（含 AUTH-SCOPE-01/02 与记录提交）；本检查点实现提交 `c435442` 随后推送 |

说明：Worker 工具端口现在统一经过范围门禁，全量 206 文件/1669 用例仍全通过，说明既有 devolve 写入、
assist 项目内写入与只读路径未受影响；思索模式写入与跨根/未知/安装的人工裁决按 ADR-0039 生效。

## 6. 未满足项与后续

- **ACCURACY-01**（用户文档推荐顺序的下一节点）：审计签收/完成链路并冻结档位、预算与跳过状态。
- 治理文档统一修订（AGENTS.md 安装/外部软件条款、测试预期、CLI/TUI 文案）尚未开始。
- CLI/TUI 设置界面与跨进程实时授权交互、外部软件控制能力仍缺。
