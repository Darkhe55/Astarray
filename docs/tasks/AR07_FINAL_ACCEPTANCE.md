# AR-07 最终验收台账（进行中）

> 状态：`in_progress`  
> 依据：`AUDIT_REMEDIATION_TASKS.md` AR-07 与“最终安全验收清单”（51 项）  
> 关联：`PLAN_STATUS.md`、`DELIVERY_REPORT.md` §10

## 1. 已完成的本地动态证据（2026-09-10）

| 项目 | 命令 | 结果 |
|---|---|---|
| 完整门禁 | `npm run check` | exit 0：135 文件 / 1301 测试（此后新增测试未再全量复跑，见 §4） |
| 全局覆盖率 | `npm run test:coverage` | exit 0：分支 85.06%（3605/4239），lines 93.00%，funcs 90.02% |
| 打包与隔离安装 | `npm pack` + `verify-package.mjs` + `smoke-install.mjs` | 全部 exit 0：171 文件；隔离安装、CLI 冒烟、全局 .cmd shim、feedback-entry ESM 加载 |
| 依赖风险 | `npm audit --audit-level=high` | exit 0；4 项低/中危均为 dev 工具链（vitest、esbuild），生产依赖无 high/critical |
| 恢复与安全回归 | 恢复单元 5 套件 + 故障注入 | 34/34 通过 |

## 2. 关键模块分支覆盖率基线（AR-07 §1 定义范围）

| 模块 | 分支覆盖（基线） | 缺口 |
|---|---|---|
| tools/current-permission-selection.ts | 66.7% (8/12) | 4 |
| orchestration/unbounded-agent-registry.ts | 72.2% (13/18) | 5 |
| tools/installation-gate-guard.ts | 78.1% (25/32) | 7 |
| core/completion-protocol.ts | 80.0% (12/15) | 3 |
| tools/sensitive-content-access-policy.ts | 80.0% (44/55) | 11 → 本轮补测后 targeted 92.7% |
| tools/evidence-search-agent-port.ts | 81.3% (13/16) | 3 |
| orchestration/work-archive-store.ts | 81.3% (13/16) | 3 |
| tools/read-suppression-ledger.ts | 81.5% (22/27) | 5 |
| tools/backup-vault.ts | 82.1% (69/84) | 15 → 本轮补测后 targeted 88.1% |
| tools/policy-wrapper.ts | 85.2% (46/54) | 8 |
| feedback-process/process-supervisor.ts | 85.7% (48/56) | 8 |
| tools/local-tool-policy-engine.ts | 85.7% (36/42) | 6 |
| tools/protected-storage-policy.ts | 87.0% (20/23) | 3 |
| tools/permission-capability-catalog.ts | 87.5% (14/16) | 2 |
| feedback-process/entrypoint.ts | 87.7% (57/65) | 8 → 本轮补 1（默认 writeStderr） |
| tools/permission-profile-store.ts | 88.1% (37/42) | 5 |
| orchestration/agent-run-watchdog.ts | 88.2% (30/34) | 4 |
| tools/local-progress-and-cycle-guard.ts | 89.8% (44/49) | 5 |
| tools/configurable-permission-policy-engine.ts | 90.3% (28/31) | 3 |
| tools/local-sensitive-operation-classifier.ts | 90.9% (10/11) | 1 |
| tools/session-permission-elevation.ts | 91.3% (63/69) | 6 |
| feedback-process/mailbox-journal.ts | 91.8% (45/49) | 4 |
| 其余 14 个关键模块 | ≥95% 或 100% | 0 |

> 基线为 2026-09-10 全量覆盖率运行；括号内为 covered/total 分支。

## 3. 本轮（AR-07 批次 1）补测与结论

新增 `tests/core/unit/ar07-module-gaps.test.ts`（9 例）与反馈入口默认回调测试（1 例）：

- **backup-vault**：二进制快照 base64、目录快照清单、非对象损坏快照 fail-closed（`journal-corrupted`）、恢复不存在报 `mission-not-found`、隔离/清除未知 ID 安全跳过。定向覆盖率 82.1% → **88.1%**（仍需 +6 分支达 95%）。
- **sensitive-content-access-policy**：`isSameResource` 真实路径一致/硬链接身份一致/均不同三分支、附加敏感模式归 `admin-extended`、DLP 类别缺失时 `dlp:unknown` 稳定拒绝。定向 **92.7%**（差 2-3 分支；其中 Windows 不可达的两个平台条件分支需 Linux/macOS CI）。
- **policy-wrapper**：安装门禁默认执行标识（`unknown-agent`/空任务 ID）、可配置引擎 `ask` 路径、引擎装配但引用 undefined 拒绝授予。
- **feedback entrypoint**：省略 `writeStderr` 时断开路径使用默认 stderr 输出。

## 4. 下一步计划（逐模块推进到 ≥95%）

1. backup-vault 剩余 +6：`purgeQuarantinedBackups` 的 ENOENT 容忍分支、目录快照符号链接跳过（Windows 退化为 junction）、审计链 `readLastRecordHash` 空文件/缺 `recordHash` 分支。
2. policy-wrapper 剩余：`recordAudit`/静态拒绝分支与配置引擎 `allow/deny` 组合矩阵。
3. process-supervisor（缺 8）、completion-protocol（缺 3）、work-archive-store（缺 3）、read-suppression-ledger（缺 5）、local-progress-and-cycle-guard（缺 5）等按同一方式逐模块补。
4. 每轮：免审批 `--configLoader runner + --pool=threads` 定向验证 → 审批可用时跑全量 `npm run test:coverage` 复测模块与全局 → 更新本台账。
5. 最后执行完整门禁 + tarball 入口/退出码复验 + 51 项清单逐项勾选/标注。

## 5. 无法本地验证项（保持未勾选）

- Linux/macOS × Node 20/新 LTS 跨平台矩阵（含平台条件分支与 shim）；
- Node 20 运行时验证（本机为 Node 24.18.0）；
- 真实 Provider `live-smoke-verified`/`product-path-verified`（无凭据、CLI `run` 仍仅 mock）；
- dev 工具链 audit 修复（vitest/esbuild 中低危，未升级）；
- `recover` CLI 深层接线（当前为 fail-closed 基线）。
