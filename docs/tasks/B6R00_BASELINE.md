# B6R-00 基线冻结证据（2026-08-16）

> 任务卡：`docs/tasks/BATCH6_REPAIR_TASK_CARDS.md` B6R-00
> 目标：保存返修前可追溯证据；不修改生产代码。

## 环境

| 项 | 值 |
|---|---|
| Git HEAD | `de5d7ab`（feat(communication): T08B ...） |
| 工作区未提交 | 26 个文件（另一会话的文档/ADR 改动；返修不触碰） |
| Node | v24.18.0 |
| npm | 11.16.0 |
| OS | win32 x64 10.0.26100（Windows 11） |

## 动态证据

| 命令 | 退出码 | 结果 |
|---|---|---|
| 四批目标测试（assist-installation-gate / permission-profiles / session-permission-elevation / agent-lifecycle-and-memory） | 0 | 4 文件 / 70 测试通过 |
| `npm run check` | 0 | 53 文件 / 665 测试通过 |
| `npm run test:coverage` | 0 | Statements 92.3x% / Branches 85.23% |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + 全局 shim + 反馈入口全通过 |

## 单模块分支覆盖率核查（目标 ≥95%）

| 模块 | 分支覆盖率 | 达标 |
|---|---|---|
| installation-operation-classifier | 80.37% | ✗ |
| assist-installation-gate | 85.29% | ✗ |
| permission-capability-catalog | 87.5% | ✗ |
| permission-profile-store | 87.5% | ✗ |
| configurable-permission-policy-engine | 90.32% | ✗ |
| session-permission-elevation | 90.69% | ✗ |
| main-agent-readonly-projection | 80% | ✗ |
| session-shutdown-and-export | 52.77% | ✗ |
| agent-individual-memory | 87.5% | ✗ |
| tertiary-lifecycle | 95% | ✓ |
| unbounded-agent-registry | 66.66% | ✗ |
| agent-communication-delegation | 84.31% | ✗ |
| tool-documentation-recall | 83.33% | ✗ |
| main-agent-report-archive | 78.6% | ✗ |

结论：除 tertiary-lifecycle 外全部未达 ≥95% 单模块门槛；全仓均值不替代单模块门槛。

## dist 可达性扫描（最终 bundle 是否包含新增控制器）

| 控制器 | dist 可达 |
|---|---|
| permission-capability-catalog | ✓ |
| assist-installation-gate | ✗ |
| installation-operation-classifier | ✗ |
| permission-profile-store | ✗ |
| configurable-permission-policy-engine | ✗ |
| session-permission-elevation | ✗ |
| main-agent-readonly-projection | ✗ |
| session-shutdown-and-export | ✗ |
| agent-individual-memory | ✗ |
| conversation-task-insertion-controller | ✗ |
| tertiary-lifecycle | ✗ |
| main-agent-report-archive | ✗ |
| cross-agent-attachment-controller | ✗ |
| unbounded-agent-registry | ✗ |
| agent-communication-delegation | ✗ |
| tool-documentation-recall | ✗ |
| tool-help-recall-controller | ✗ |

结论：除 `PermissionCapabilityCatalog` 外，本批新增控制器未进入最终 `dist`；
安装后的 CLI/TUI 无法触发 T06E 门禁、T06F 权限组、T06G 提升、T08A 编排
（smoke-install 通过只证明入口可运行，不证明新增功能可达）。

## 跨平台

无 Linux/macOS CI 证据（仅 Windows 本地验证）。

## B6R-00 交付

- 生产代码：未修改。
- 状态纠偏：T06E/T06F/T06G/T08A 在 `PLAN_STATUS.md` 标记为返修中。
- 未决：B6R-01 ~ B6R-10 按偏序依次执行。
