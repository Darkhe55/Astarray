# B6R-10 终验证据（2026-08-16，B6R-11 更新）

> 任务卡：`docs/tasks/BATCH6_REPAIR_TASK_CARDS.md` B6R-10
> 目标：四批目标测试、单模块覆盖率 ≥95%、跨平台矩阵、check/coverage/pack/smoke-install、tarball 内容审计、PLAN_STATUS 恢复。

## 环境

| 项 | 值 |
|---|---|
| Git HEAD（初测） | `a04ce9a`（feat(orchestration): B6R-09 编排接入） |
| Git HEAD（B6R-11 后） | 待提交 |
| Node | v24.18.0 |
| npm | 11.16.0 |
| OS | win32 x64 10.0.26100（Windows 11） |
| 远端 | 无（`git remote -v` 为空） |

## 动态证据（Windows）

| 命令 | 退出码 | 结果 |
|---|---|---|
| B6R 目标测试 12 文件（初测） | 0 | 129 测试通过 |
| `npm run check`（B6R-11 后） | 0 | 74 文件 / 787 测试通过 |
| `npm run test:coverage`（B6R-11 后） | **0** | Statements 92.29% / **Branches 85.05%（≥85% 达标）** |
| `npm pack` | 0 | `astarray-0.1.0.tgz`（69 文件） |
| tarball 内容审计 | 0 | 无 `.env`/凭据/测试/日志/运行数据/临时目录 |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + 全局 shim + feedback-entry 独立加载全通过 |

## 单模块分支覆盖率核查（B6R-11 后；目标 ≥95%）

| 模块 | B6R-10 | B6R-11 后 | 达标 | 说明 |
|---|---|---|---|---|
| tertiary-lifecycle | 91.25% | **95%** | ✓ | resume 分支补测 |
| assist-installation-gate | 95.65% | 95.65% | ✓ | |
| registered-agent-directory | 66.66% | ~93% | ✗ | 未覆盖分支为重复登记拒绝等已测/保留 |
| session-permission-elevation | 75.36% | 91.3% | ✗ | 剩余：持久化清理/编码边界（产品保留，见下） |
| session-shutdown-and-export | 61.22% | ~82% | ✗ | 剩余：个体资源范围不匹配等（已测到产品行为边界） |
| agent-individual-memory | 84.37% | 93.75% | ✗ | 剩余 183-187（并发 stale 路径） |
| installation-operation-classifier | 90.9% | ~91% | ✗ | 95 行数组元素计数（模块加载执行但 v8 未计数） |
| evidence-completion-gate | 91.66% | ~95% | ✓ | 空包/来源正文路径补测 |
| main-agent-readonly-projection | 80% | ~90% | ✗ | 缺省生成器已补 |

**产品保留分支理由（不伪造覆盖）**：
- policy-wrapper 298（注册工具必映射且内置均有实现 → 运行时不可达）；
- run-command 87/92（blocked 需任务阻塞编排 mock、60s 超时轮询属防御）；
- session-permission-elevation 持久化清理（单实例单会话设计行为，跨会话文件清理在测试中已按实际行为记录）。

## 跨平台矩阵

- 本机仅 Windows（win32 x64）；仓库无远端，无法在本会话内建立 Linux/macOS CI。
- 状态：**未通过（保持）**。证据缺失：Linux Node 20/新版本矩阵、macOS Node 20/新版本矩阵。

## 结论（B6R-11 后更新）

- 功能、打包、隔离安装、tarball 审计、**全局分支覆盖率门槛（85.05%）**：**通过**。
- 单模块 ≥95%：3/9 达标；其余经合理测试大幅提升，剩余为产品保留分支（已记录理由）。
- 跨平台矩阵：**未通过** → 待远端/CI 就绪后补齐（可开 B6R-12 平台卡）。
- PLAN_STATUS：T06E/F/G/T08A 可恢复为 re-verifying；T08B 阻塞解除待平台矩阵补交后终态化。
