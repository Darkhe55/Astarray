# E2E-01-02 切片 5：tarball 隔离安装下的纵向复现与交付检查

> 检查点：E2E-01-02（仍为 **in_progress**：验收 1–5 均已有证据；剩余"侦察/规划产品步骤"与"纵向编排产品化"）
> 前驱：切片 4b。日期：2026-09-10
> 运行目录：`.tmp/e2e01/slice5d/project-0b936a`（隔离安装项目）

## 1. 交付检查（共同契约 §4）

| 命令 | 结果 |
| --- | --- |
| `node scripts/smoke-install.mjs` | exit 0（tarball → 隔离安装 → `--version`/`--help`/`doctor`/`run` → 全局 prefix shim） |
| `npm pack` + `node scripts/verify-package.mjs <tarball>` | exit 0；201 个文件，shebang/BOM 正确，含反馈进程入口 |
| 隔离安装（`npm install <tarball>`） | exit 0，41 个包 |
| `astarray doctor --json`（隔离安装的 CLI） | exit 0 |

tarball sha256：`d01909cd80454f4d3e1a2de4bf5617f19ddfb2244faa540674d18f029757849e`。

## 2. 纵向场景（全部经**隔离安装的 CLI** + 本地协议服务器）

| 步骤 | 结果 |
| --- | --- |
| 实现第一版（脚本化 `replaceFileContent` 写入错误实现） | CLI `run --mode devolve --runtime openai-compatible` exit 0，mission done |
| 冻结测试 | **失败**：`E2E01_BASELINE_FAILURE 摘要与冻结预期不一致: {"totalCount":0,...,"summaryText":"未实现"}` → 触发返修 |
| 返修（写入参考实现） | CLI exit 0，mission done（第二次 provider 请求返回完成控制事件） |
| 冻结测试 + 产物 | **通过**：`E2E01_TESTS_PASSED`；`produce-artifacts` 写出 `out/summary.json` 与 `out/test-evidence.json`；summary sha256 = `fc1328fbf46322119135a516954d200d99f5afa4cc047f0ec48f5d5b09e5830d`（与 E2E-01-01 冻结证据一致） |
| 独立验收（第三个 mission，assist + `readFile`） | CLI exit 0，mission done（只读复核产物） |
| 证据包 | `evidence-create` + `evidence-validate` 均通过；`runIdentifier=e2e01-02-20260912T144256Z`、`provider.kind=local-fake`、`modelProfileId=fake-model`、`fixtureFingerprint=sha256:6512b2a6…4c7c` |

## 3. 本轮发现并修复的缺陷（重要）

1. **本地协议服务器缺少脚本化工具调用分支**（`.tmp` 之前的运行中）：CLI 只收到一次
   "完成"响应、从未执行工具，任务却报 `done` 且**没有产物**——只有冻结测试与产物哈希检查
   才能发现。修复后 provider 请求 2 次（工具调用 → 完成），文件真实落盘。
   这也再次印证：**完成状态不等于产物存在**，验收必须核对产物。
2. **证据协议把 `local-fake` 也当作需要凭据授权**：`validateEvidenceBundle` 原先要求所有非
   `mock` 的 Provider 都带 `credentialsAuthorized`。本地假服务器不联网、无费用，现仅对
   `kind === "real"` 强制授权；契约测试补充"local-fake 无需授权即通过"用例。
3. **测试在满载下的偶发失败**（`e2e01-provider-write-probe`）：50 秒等待上限 + 关闭后立即清理
   临时目录导致 `EPERM rename` 未处理拒绝；已放宽到 90 秒等待上限、测试超时 120 秒，并在关闭后
   静置 200ms 再清理。修复前 `smoke-install`（其 `prepack` 会跑全量 check）因此失败。

## 4. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；176 文件 / 1499 用例通过 |
| `npm run test:coverage` | 本轮无产品代码变更，未重跑（最近一次：176 文件 / 1499 用例、branch 86.54%） |
| 交付检查 | smoke-install / verify-package / 隔离安装 / doctor 均 exit 0（§1） |
| 纵向场景 | 实现→失败→返修→通过→产物→独立验收→证据包 全部通过（§2） |

## 5. 本检查点剩余

- **侦察 / 规划步骤产品化**：当前纵向流程覆盖实现→测试→返修→独立验收（切片 4a/tarball 复现）与
  次级集成/主报告（切片 4b）；"侦察→规划"尚无产品级步骤进入该流程。
- **纵向编排产品化**：step 间编排仍在验收流程内（每步都是真实产品执行）；成为产品能力需在次级
  调度层显式编排。
- **E2E-01-03**：真实 Provider + 人工并发变化，仍待用户凭据与费用授权。
