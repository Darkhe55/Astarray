# SUM-01-04b 摘要 CLI 接线与安装包消费 — 证据

> 检查点：SUM-01-04（04b，docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：SUM-01-04a（提交 `dae16e1`）。日期：2026-09-15
> 契约：docs/adr/0034-summary-manifest-and-dynamic-detail.md §24–27（本检查点不再新增契约）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/tui/src/cli/commands.ts`（扩展） | `executeSummaryListCommand`（无来源时状态诚实 `no-summary`，退出码 1）、`executeSummaryBuildCommand`（真实 mission 存档 → 摘要发布；无记录时 `no-history`）、`executeSummaryShowCommand`（四级读取 / `--chunk` 章节展开 / `--max-return-units` 有界返回；缺失来源 `summary-not-found` 退出码 1） |
| `packages/tui/src/cli.tsx`（扩展） | `astarray summary list\|build <mission-id>\|show <source> [--level] [--page-size] [--chunk] [--max-return-units] [--json]` |
| `packages/core/src/public-sdk.ts`（扩展） | 章节视图补充 `sourceRevisionFrom/To`（供 CLI/消费者展示行区间） |
| `tests/tui/integration/summary-cli.test.ts`（新，2 用例） | 空来源诚实状态；build→list→show→章节展开→有界返回→缺失来源全链路 |
| `scripts/verify-summary-package.mjs`（新） | 安装包消费验证：以文档化 schema 的工作存档 fixture 造 2400 条大历史 → **只用安装包公共 SDK** 构建摘要、分页读取、章节展开，并输出设备/输入/耗时/资源观测 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 无摘要来源时 CLI 返回成功空数据 | 诚实 `no-summary` + 退出码 1 | ✅ `summary list` 空目录 → `{status:"no-summary"}`、exit 1 |
| mission 无工作记录时写空摘要冒充成功 | 诚实 `no-history` | ✅ `summary build` 对空 mission 返回 `no-history`、exit 1 |
| 读取不存在来源被当作空页 | 显式 `summary-not-found` | ✅ `summary show mission-does-not-exist` → exit 1 + 状态 |
| 资源不足时裁剪清单 | 只裁剪本次返回 | ✅ `--max-return-units 1` → `isReturnBounded=true`、返回 0 单位，而覆盖率 `chunkCount` 与完整读取一致 |
| CLI 绕过公共门面直接读内部存储 | 经公共门面 | ✅ 三个命令均经 `AstarrayApplicationFacade`（`summarizeArchivedMission`/`listSummarySources`/`readSummaryView`/`expandSummarySectionView`） |
| 安装包只能跑 doctor/run，不能消费摘要 | 包内公共 SDK 可读取大历史摘要并展开 | ✅ 隔离安装后 2400 条历史 → 2400 分块、1.70 MB 索引、12 页分页、章节展开，全部检查项 true |

## 3. 安装包消费实测（设备/输入/输出）

命令：`npm install astarray-0.1.0.tgz --prefix .tmp/summary-package-verify` →
`node scripts/verify-summary-package.mjs --package-dir .tmp/summary-package-verify/node_modules/astarray`

| 项 | 值 |
| --- | --- |
| 设备/运行时 | win32 x64，Node v24.18.0，24 vCPU，总内存 16104 MiB |
| 输入规模 | 6 个 Agent × 400 条 = **2400 条工作存档条目**，fixture 547722 字节 |
| 输出索引 | 2400 个分块，**manifest 1697968 字节（1.70 MB）**，generator `local-extractive-1` |
| 分页 | 每页 200 → **12 页**，累计返回 28800 计量单位 |
| 耗时 | 生成摘要 **236 ms**；遍历全部分页 **222 ms**；章节展开 **15 ms** |
| 有界返回 | `maximumReturnUnitCount=1` → `isReturnBounded=true`、清单仍 2400 分块 |
| 诚实性检查 | 条目数/分块数/覆盖完整/索引落盘/读取不触原文/章节有证据指针/有界返回不裁剪清单 —— **8/8 true** |

## 4. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/tui/integration/summary-cli.test.ts` | 0；2 passed |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| `npm run check` | **exit 0**：193 文件 / **1595 用例全通过** |
| `npm run test:coverage` | **exit 0**：193 文件 / 1595 用例；全局 93.32% / branch **85.88%** / 92.25% / 93.35%；`summarization` 目录 91.51 / 80.61 / 95.95 / 91.38 |
| `npm pack` | exit 0；tarball sha256 `8ff877029693061560c1312a62a78805182472032ebd067dc485f5740bb06e0a` |
| `node scripts/verify-package.mjs <tarball>` | exit 0；209 文件，shebang/BOM 正确，反馈进程入口已包含 |
| `node scripts/smoke-install.mjs` | exit 0；隔离安装 + `doctor` + `run --runtime mock` → done + 全局 shim + 反馈入口加载 |
| `node scripts/verify-summary-package.mjs` | exit 0；上表 8/8 检查通过 |

**已知波动与处理（如实记录）**：`npm pack` 的 `prepack` 会重跑全量 check，本检查点两次命中既有
`tests/core/integration/e2e01-vertical-rework.test.ts` 的间歇失败（`running`/`blocked` vs `done`，非本批代码路径）；
处理方式是**有界重试**（pack/smoke 各至多 2 次，成功即止），未跳过 `prepack`、未跳过任何测试、未放宽断言。
必跑门禁 `npm run check` 与 `test:coverage` 已在同一提交上通过并推送（`fd6560f..7315169`）。

## 5. 未满足项与后续

- SUM-01 其余来源适配器（会话历史、报告、延后文件）与旧文件迁移/触发阈值测量仍待后续检查点。
- 资源测量目前是单机单次样本（Windows、24 vCPU、2400 条），未做多设备/多规模重复测量与 p50/p95。
- SUM-01 完成后按 steering 顺序进入 SUM-02（跨模型预算与摘要事实可靠性）。
