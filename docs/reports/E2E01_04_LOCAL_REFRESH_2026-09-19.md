# E2E-01-04 本地可证项刷新（2026-09-19）

> 检查点：E2E-01-04（**in_progress**）本地可证项的当前提交刷新 + E2E-01-01 fixture 复现复核 + 验收脚本静默误报修复
> 基线提交：`6461690`（本检查点再叠加文档与 `scripts/e2e01-acceptance.mjs` 诊断改进）
> 结论：本地可证项在当前提交全部复现通过；未决必选项（人工体验结论、Linux/macOS 平台、真实 Provider 场景）仍未满足，故 E2E-01-04 保持 in_progress。
> 本文刷新 `docs/reports/E2E01_04_QUALITY_STATEMENT.md`（2026-09-10 的 178 文件/1504 用例口径）；该文件保留为历史记录。

## 1. 当前提交上的门禁与覆盖率

| 检查 | 结果 | 来源 |
| --- | --- | --- |
| `tsc --noEmit` | exit 0 | 直接 `node node_modules/typescript/bin/tsc` |
| `eslint .` | exit 0 | 直接 `node node_modules/eslint/bin/eslint.js` |
| 构建（tsup） | Build success | `.tmp/linux-port-01/build.log` |
| 全量 `vitest run --maxWorkers=6` | **228 文件 / 1854 用例**通过 | `.tmp/linux-port-01/full-test.log`、`coverage-final.log` |
| `vitest run --coverage` | exit 0；全局 **93.09 / 85.24 / 93.13 / 93.11**（行/分支/函数/语句，阈值 85 满足） | `.tmp/linux-port-01/coverage-final.log` |
| `verify:security-coverage` | **22/22 达标（阈值 95%）** | `.tmp/linux-port-01/security-coverage.log` |
| `npm pack` + `verify-package.mjs` | exit 0；**215 文件**（旧 207/209 产物已过期） | `.tmp/gui01-r-04b/{pack2,verify2}.log` |
| tarball | `astarray-0.1.0.tgz` sha256 `a45ae4dab9f3e99fa45ed75b16e98e262d112acb449a0c048fe5936b5fd96d1f`、mtime `2026-09-19T23:18:48Z` | 同上 |
| `smoke-install.mjs` | exit 0（隔离安装 + 全局 shim + 反馈进程入口） | `.tmp/gui01-r-04b/smoke2.log` |
| 隔离安装包 GUI 冒烟 | `GET /` 200、`GET /state` 200 且脱敏、端口释放、无孤儿 | `docs/reports/GUI01_R_04B_TARBALL_GUI_SMOKE_EVIDENCE_2026-09-19.md` |
| stdio MCP 桥接闭环 | 13/13 通过（含协议/业务失败区分） | `docs/reports/BRIDGE01_04_STDIO_CLOSED_LOOP_EVIDENCE_2026-09-19.md` |

自助打包一致性：上述 tarball 生成后，`dist/`、`README.md`、`LICENSE` 与 `package.json` 均未再改动（本检查点只新增 `scripts/` 与 `docs/`，二者不随包发布），因此该哈希仍对应当前提交的包内容。

## 2. E2E-01-01 fixture 复现复核（本轮实跑）

`node scripts/e2e01-acceptance.mjs fixture`（完整访问）：

```json
{
  "fixtureFingerprint": "sha256:6512b2a6322fb6b6730b68fb4029b622b8fc7f06e1f3adee0342b7d044e94c7c",
  "fileCount": 11,
  "baselineFailedAsFrozen": true,
  "solutionPassedAsFrozen": true,
  "artifactHashes": {
    "out/summary.json": "fc1328fbf46322119135a516954d200d99f5afa4cc047f0ec48f5d5b09e5830d",
    "out/test-evidence.json": "ddbf68abff3dc115b418bf4edf306aa6b04bf7a2d055116d5258d77ba4f95db3"
  }
}
```

- fingerprint 与冻结值一致（`6512b2a6…e94c7c`，11 文件）；
- 基线按冻结预期**必须失败**（`E2E01_BASELINE_FAILURE`），参考实现按冻结预期**必须通过**（`E2E01_TESTS_PASSED`）；
- 两个产物 sha256 与 2026-09-10 首次记录**逐字节一致** → fixture 与参考实现具备确定性。

## 3. 顺带修复：验收脚本静默误报（行为反例 → 修复）

**反例**：在受限文件沙箱（workspace-write）下运行同一命令，脚本输出只有：

```json
{ "baselineFailedAsFrozen": false, "solutionPassedAsFrozen": false, "artifactHashes": {} }
```

无任何原因说明——看起来像"fixture 坏了"。实际原因是 `execFileSync` 管道启动子进程被沙箱拒绝：独立探针实测 `spawnSync … EPERM`，而 `runNodeScript` 的 `catch` 把失败原因丢掉了。

**修复**（`scripts/e2e01-acceptance.mjs`）：
1. `runNodeScript` 在 spawn 失败（无 `error.status` 且有 `error.code`）时，把 `[spawn <CODE>]` 前缀写进捕获输出；
2. 摘要新增 `failureDiagnostics`（仅失败时出现），给出基线与参考实现的退出码与输出摘录。

**修复后反例可见**：

```json
"failureDiagnostics": {
  "baselineExitCode": 1,
  "baselineOutputExcerpt": "[spawn EPERM] ",
  "solutionExitCode": 1,
  "solutionOutputExcerpt": "[spawn EPERM] [spawn EPERM] "
}
```

**完整访问下最终实跑**：exit 0，摘要**不含** `failureDiagnostics`（见 §2）。

## 4. 未决必选项（不得 done）

- 人工走查结论（证据包内强制 `pending-manual`）；
- Linux/macOS 平台结果（Linux 待用户机器在同一提交上独立重跑）；
- 真实 Provider 场景（E2E-01-03，需用户提供凭据与费用授权）。

## 5. 复现

```bash
node scripts/e2e01-acceptance.mjs fixture          # 需可启动子进程（受限沙箱下会给出 [spawn EPERM] 诊断）
npm run verify:security-coverage                    # 依赖 coverage/coverage-summary.json
```
