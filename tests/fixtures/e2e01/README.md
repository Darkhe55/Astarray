# E2E-01 验收 fixture（独立工作助手纵向验收）

> 检查点：E2E-01-01（fixture 与证据协议）。本目录是**冻结**的验收输入，
> 任何改动都视为修订 fixture，必须在证据包中更换 fingerprint。

## 目录

- `run-config.json`：冻结的运行配置（模式、运行时、Provider/模型、权限、预算、人工验收策略）。
- `resource-recon.json`：资源盘点（依赖、网络、安装、凭据需求）。
- `scenario.json`：纵向闭环场景步骤与身份要求（实现/测试/验收必须不同身份，强制一次返修）。
- `expected-artifacts.json`：预期产物路径、必备字段与期望值（成功标准）。
- `project/`：小型目标项目：`src/summarize-tasks.mjs` 为冻结桩（必然失败），
  `test/run-tests.mjs` 为冻结失败测试，`solution/` 为参考实现（仅用于证明 fixture 成功路径可复现）。

## 成功 / 失败标准（冻结）

- 基线（未实现）：`node test/run-tests.mjs` 退出码非 0，且输出包含 `E2E01_BASELINE_FAILURE`。
- 成功：`node test/run-tests.mjs` 退出码 0，输出包含 `E2E01_TESTS_PASSED`；
  `node test/produce-artifacts.mjs` 产出 `out/summary.json` 与 `out/test-evidence.json`，
  且 `out/summary.json` 与 `expected-artifacts.json` 的 `expectedSummary` 完全一致。

## 自动与人工检查分离

- 自动检查：fixture 基线/成功运行、`npm run check`、`npm run test:coverage`、tarball 打包校验。
- 人工检查（本检查点不可自动置为已通过）：真实工作流走查、真实 Provider 场景观察、
  人工工作树并发变化观察（E2E-01-03）。

## 使用

```powershell
node scripts/e2e01-acceptance.mjs fixture          # 脚手架 + 基线 + 参考实现闭环
node scripts/e2e01-acceptance.mjs scaffold .tmp/e2e01/fixture
node scripts/e2e01-acceptance.mjs evidence-create --run-id <id> --tarball <tgz> --config run-config.json --out evidence.json
node scripts/e2e01-acceptance.mjs evidence-validate evidence.json
```
