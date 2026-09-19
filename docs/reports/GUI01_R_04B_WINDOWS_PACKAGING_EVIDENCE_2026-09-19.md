# GUI-01-R-04b Windows 打包验收重跑证据（2026-09-19）

> 检查点：GUI-01-R-04b 的**打包自动部分**（人工体验与平台证据仍缺）
> 基线提交：`04ddce7`（LINUX-PORT-01 返修；`f0fb9a0` 仅多一个文档提交）
> 环境：Windows（本机工作区），Node `v24.18.0`，npm `11.x`
> 结论：打包链路在本提交上**全部 exit 0**，并产出与当前代码一致的新 tarball；04b 的人工体验与 Linux/macOS 证据仍未做，卡片保持 in_progress。

## 1. 为什么要重跑

Linux 机器此前校验的 `astarray-0.1.0.tgz` 是 **2026-09-15 的旧产物**（sha256 `c0c383ac…de206`，与本机同名旧文件逐字节一致），而当时 `npm pack` 的 prepack 因测试失败而不会产出新包，导致"包内容校验通过"实际校验的是过期产物（详见 `docs/reports/LINUX_PLATFORM_FAILURE_TRIAGE_2026-09-19.md` §2.1）。本轮在返修提交上重跑打包链路，消除该证据隐患。

## 2. 执行与结果

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 全量门禁（prepack 内） | `npm run check` | typecheck / lint / build / test 全通过：**228 文件 / 1854 用例**，exit 0 |
| 打包 | `npm pack` | exit 0，npm 报告 `total files: 215` |
| 包内容 | `node scripts/verify-package.mjs <tgz>` | exit 0：`打包校验通过: 215 个文件，shebang/BOM 正确，反馈进程入口已包含` |
| 隔离安装冒烟 | `node scripts/smoke-install.mjs` | exit 0：`冒烟测试全部通过 ✓`（`--version` 0.1.0、`--help`、`doctor --json`、`run --runtime mock` → done、全局 `astarray.cmd` shim、反馈进程入口可加载） |

产物：

| 项 | 值 |
| --- | --- |
| 文件 | `astarray-0.1.0.tgz` |
| mtime | `2026-09-19T23:18:48Z`（新） |
| SHA256 | `a45ae4dab9f3e99fa45ed75b16e98e262d112acb449a0c048fe5936b5fd96d1f` |
| 文件数 | 215（旧产物 207/209，已过期） |
| npm shasum | `24b46ed0d74e2882d0a647870194445c4d1a28d3` |

日志：`.tmp/gui01-r-04b/{pack2,verify2,smoke2}.log`（`.tmp/` 已 gitignore）。

## 3. 顺带修复：T11 CLI 计时脆弱（阻塞打包验收）

首次重跑时 `npm pack` 的 prepack 失败（`.tmp/gui01-r-04b/pack.log`）：

```
FAIL  tests/tui/unit/cli-commands.test.ts > CLI 命令（直接调用） > run：mock 运行时 mission 完成，stdout 为 JSON
Error: Test timed out in 20000ms.
```

根因：该文件第 19 行已声明 `vi.setConfig({ testTimeout: 60_000 })` 并注明"覆盖率插桩 + Windows 临时目录竞争下真实 mission 链路会明显变慢：仅调整超时，断言不变"，但文件内有 5 处单测级 `20_000` 覆盖（第 61/275/317/349/465 行），与文件级设定自相矛盾，重负载时最重的 mock mission 用例会越过 20s。

处理：将该文件 5 处 `20_000` 统一为 `60_000`（仅测试时限，**断言不变**）。隔离复跑 `tests/tui/unit/cli-commands.test.ts` → **22/22 通过（8.86s）**；随后 `npm pack` 的 prepack 全量门禁 **228 文件 / 1854 用例**通过。

## 4. 未做与残留

- 本轮**未**重跑 `npx astarray gui --no-open` 的从安装包启动冒烟（该自动部分此前已在 GUI-01-R-04a 记录，未在本轮复跑，不做重复声明）。
- 人工体验十项、Linux/macOS 平台证据仍未做；本文件不构成这些结论。
- 平台表不更新：按用户要求，Linux 需在同一提交上独立重跑、证据齐全后再更新。
- Linux 侧重跑时请记录**新 tarball 的 mtime 与 SHA256**，确认不是 `2026-09-15`/`c0c383ac…` 的旧产物。
