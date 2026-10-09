# E2E-01-04 分支覆盖率缺口作战图（2026-10-09）

> 目的：把"分支覆盖率 83.29% < 85%、还需 161 条"从**文件级排名**推进到**行级可执行清单**。
> 生成方式见 §4；定位工具：`scripts/report-uncovered-branches.mjs`（本轮新增，已入库）。

## 1. 当前口径（`--maxWorkers=6`，290 文件 / 2193 用例全通过）

| 项 | 值 |
| --- | --- |
| 全局分支 | **7848 / 9422 = 83.29%**（2026-09-19 基线为 85.24%） |
| 达到 85% 还需覆盖 | **161 条** |
| 行 / 函数 / 语句 | 92.05 / 92.5 / 92.09 |

## 2. 关键区分：无位置信息(L0) vs 可定位

v8 会产出**没有位置信息**的分支（行号 0）。它们**无法靠补测定向覆盖**，因此必须与可定位分支分开看：

| 池 | 覆盖 | 未覆盖 | 说明 |
| --- | --- | --- | --- |
| 无位置信息(L0) | 1994/2217 = 89.9% | 223 | 无法定向补测 |
| **可定位(line>0)** | 5854/7205 = 81.2% | **1351** | **161 条缺口只能从这一池补** |

> 推论：不要把 L0 的 223 条算进"可补缺口"，否则会低估难度、也会去追盖不到的东西。

## 3. 可定位未覆盖分支 Top（含行号）

| 文件 | 未覆盖 | 主要行（类型×条数） |
| --- | --- | --- |
| `packages/tui/src/cli/commands.ts` | **320** | L34, L100–L102, L111, L142, L145, L210, L232, L237, L254–L259, L280 …（66 个命令函数内部的错误/JSON-文本分支） |
| `packages/core/src/public-sdk.ts` | 51 | L841, L856, L902, L922, L924, L931, L1005, L1090, L1272, L1302, L1321, L1345, L1355, L1385, L1404, L1427 |
| `packages/core/src/orchestration/local-preservation-service.ts` | 44 | L267, L288, L299–L311, L330, L342, L345, L459, L587, L638, L662, L681–L692 |
| `packages/core/src/tools/read-format/read-format-strategies.ts` | 40 | L122–L125(switch), L145, L152, L163, L190, L196, L214, L231, L262, L290, L295–L299, L306 |
| `packages/core/src/tools/builtins.ts` | 31 | L425, L459, L478, L519, L537, L585, L596, L601, L614, L617, L641, L652, L655, L678, L685, L701 |
| `packages/core/src/runtime/anthropic-messages-runtime.ts` | 30 | L119, L178, L192, L205, L231–L233, L244, L276, L316, L345, L372, L376, L381–L382, L389（**非** usage 分支——usage 已由 2026-10-09 补测覆盖） |
| `packages/tui/src/cli/run-command.ts` | 28 | L42–L43/L50(default-arg), L54, L57, L65, L70–L74, L84–L86 |
| `packages/core/src/tools/read-format/read-format-other-languages.ts` | 26 | L30, L34, L38, L98, L105, L117, L134, L139, L150, L235–L247 |
| `packages/core/src/orchestration/diagnostic-event-store.ts` | 25 | L158, L236–L237, L248, L260, L288, L297, L387–L390, L402, L412, L456 |
| `packages/core/src/orchestration/cross-project-authorization-store.ts` | 23 | L110, L113, L116, L210, L222, L238, L240, L246, L267, L282, L323, L451–L460 |
| `packages/core/src/tools/scope-resolution.ts` | 23 | L95, L112, L116, L143, L147–L148, L167, L218, L252, L276, L282–L293 |
| `packages/core/src/tools/read-format/read-format-frontend-script.ts` | 22 | L42, L50, L92, L96, L120–L125, L170, L179, L248, L256, L263 |

（完整清单可用 §4 的脚本按 topN 输出。）

## 4. 复现方法（含一个坑）

**坑**：仓库 `vitest.config.ts` 的 `coverage.reporter` 只有 `["text", "html", "json-summary"]`；
CLI 传 `--coverage.reporter=json` **不生效**（实测输出目录为空）。要拿行级数据必须**复制配置并加 `json`**：

```powershell
# 1) 临时配置（放在 .tmp/，不入库）：复制 vitest.config.ts，
#    reporter 加 "json"，reportsDirectory 指向 .tmp，阈值置 0（仅用于定位）
# 2) 跑覆盖率（209+ 文件全量）：
npx vitest run --coverage --maxWorkers=6 --config .tmp/session-r2-04/vitest.covjson.config.ts
# 3) 定位缺口：
node scripts/report-uncovered-branches.mjs .tmp/session-r2-04/cov-final/coverage-final.json 15
```

## 5. 建议补测顺序（按产出/成本比）

1. **`read-format` 家族**（strategies 40 + other-languages 26 + frontend-script 22 + latex 约 20）≈ **108 条**：
   全是纯解析函数，表驱动用例即可覆盖，成本最低——单这一族就足以补齐 161 条的大半。
2. **store 家族**（diagnostic-event-store 25 + cross-project-authorization-store 23 + perf-event-store 约 21
   + instruction-window-store 约 19）≈ **88 条**：读写/解析/容错分支，构造临时目录即可。
3. **`local-preservation-service` 44** / **`public-sdk` 51**：需要较多装配，成本中等。
4. **`commands.ts` 320**：单一文件最大池，但 4290 行、分支分散在 66 个命令函数内部，成本最高，放最后。

## 6. 本轮的教训（如实记录）

2026-10-09 第一轮曾假设"未覆盖分支集中在本会话新增的 usage 逻辑"，**实测证伪**：
补了 7 条 usage 契约用例后，该文件分支仅 108→109（仍 72.66%）。
基于**文件级排名**去猜分支位置是错的——必须先拿行级数据。本文件即为纠正后的产物。
