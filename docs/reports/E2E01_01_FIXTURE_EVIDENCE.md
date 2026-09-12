# E2E-01-01 验收 fixture 与证据协议 — 实现与证据

> 检查点：E2E-01-01（docs/tasks/E2E01_STANDALONE_WORKFLOW_ACCEPTANCE_TASK_CARD.md）
> 前驱：T07D-R1 / T07D-R2（-04 因缺真实凭据 blocked）/ T09A-R1 / T12A-R1（全部已通过）
> 日期：2026-09-10

## 1. 目标与验收映射

| 验收条款 | 实现 | 证据 |
| --- | --- | --- |
| 冻结小型项目、目标功能、失败测试、权限、预算与预期产物 | `tests/fixtures/e2e01/`：`project/`（桩实现 + 冻结测试 + 参考实现）、`run-config.json`、`scenario.json`、`expected-artifacts.json`、`resource-recon.json` | §3 清单与 fingerprint；§4 fixture 契约测试 |
| fixture 可重复运行 | `scripts/e2e01-acceptance.mjs scaffold/fingerprint` 对目录内容做 sha256；两次 scaffold 指纹一致 | §3 fingerprint 两次一致（`sha256:6512…c7c`，11 文件） |
| 明确成功/失败标准 | 基线必须失败（退出码非 0 且含 `E2E01_BASELINE_FAILURE`）；参考实现必须通过（含 `E2E01_TESTS_PASSED`）且 `out/summary.json` 与冻结 `expectedSummary` 完全一致 | §3 `verify:e2e01` 输出 |
| 证据绑定 tarball 哈希、commit、配置、Provider/模型与运行 ID | `evidence-create` 生成证据包：`runIdentifier`、`commit{hash,branch,isDirty}`、`tarball{path,sha256,sizeBytes}`、`configuration{path,sha256}`、`provider{providerProfileId,modelProfileId,kind,credentialsAuthorized}`、`platform`、`fixtureFingerprint`、`artifacts[]` | §3 证据包节选；§4 证据协议用例 |
| 自动与人工检查分开 | `automatedChecks[]`（命令 + 退出码 + 状态）与 `manualChecks[]`（默认全部 `pending-manual`，置为 `verified` 必须带 `verifiedByUserId`+`verifiedAtIso`） | §4 证据协议用例 |
| 预置依赖、先收集资源情况 | `resource-recon.json`：`fixtureDependencies: []`、`requiresNetwork:false`、`requiresInstallation:false`、`requiresCredentials:false` | §4 冻结用例断言 |

## 2. 变更

- 新增冻结 fixture `tests/fixtures/e2e01/`（11 个文件）：
  - `project/src/summarize-tasks.mjs`：冻结桩（抛 `E2E01_TARGET_NOT_IMPLEMENTED`）。
  - `project/test/run-tests.mjs`：冻结失败测试（摘要一致、重复 id 拒绝、缺失依赖拒绝）。
  - `project/solution/summarize-tasks.mjs`：参考实现（仅证明成功路径可复现）。
  - `project/test/produce-artifacts.mjs`：产出 `out/summary.json` 与 `out/test-evidence.json`。
  - `project/task-chain.json`：冻结任务链（4 任务，2 done）。
  - `run-config.json`（assist / mock / local-scripted / scripted-mock-v1 / 禁止安装 / 预算 4096 / block-until-verified）、`scenario.json`（实现-测试-验收身份必须不同、强制一次返修、次级集成拒绝未授权合并、主报告按需读取）、`expected-artifacts.json`、`resource-recon.json`、`README.md`。
- 新增 `scripts/e2e01-acceptance.mjs`：`fixture|scaffold|fingerprint|baseline|solution|evidence-create|evidence-validate`。
- `package.json` 新增 `npm run verify:e2e01`；`eslint.config.mjs` 忽略 `tests/fixtures/`。
- 新增 `tests/core/integration/e2e01-fixture-contract.test.ts`（6 例）。
- **顺带修复（覆盖率负载下暴露的真实缺陷）**：`waitForResumeResult` 原为固定 60 秒上限，在负载下会把仍在推进的续接误报为 `running` 并返回失败码；现改为缺省不设上限直到终态（`blocked` 也视为终态），符合共同契约 §5「不能用固定 60 秒轮询上限误报失败」。

## 3. 运行命令与结果

```
npm run verify:e2e01        # 脚手架 + 基线 + 参考实现闭环
{
  "fixtureFingerprint": "sha256:6512b2a6322fb6b6730b68fb4029b622b8fc7f06e1f3adee0342b7d044e94c7c",
  "fileCount": 11,
  "baselineFailedAsFrozen": true,
  "solutionPassedAsFrozen": true,
  "artifactHashes": {
    "out/summary.json":      "fc1328fbf46322119135a516954d200d99f5afa4cc047f0ec48f5d5b09e5830d",
    "out/test-evidence.json":"ddbf68abff3dc115b418bf4edf306aa6b04bf7a2d055116d5258d77ba4f95db3"
  }
}
exit=0

npm pack --pack-destination .tmp/e2e01/packages
  → .tmp/e2e01/packages/astarray-0.1.0.tgz  sha256=be07c8abf43173fa61e856d6a91bf9b9c9010877787716b0275869150bd90f6f  size=621004
node scripts/e2e01-acceptance.mjs evidence-create --run-id e2e01-01-20260912T035944Z \
  --tarball .tmp/e2e01/packages/astarray-0.1.0.tgz --config tests/fixtures/e2e01/run-config.json \
  --out .tmp/e2e01/evidence-01.json                                          exit=0
node scripts/e2e01-acceptance.mjs evidence-validate .tmp/e2e01/evidence-01.json
  → 证据包校验通过                                                             exit=0
```

证据包节选（自动/人工分离，人工项全部 `pending-manual`）：

```json
{
  "evidenceSchemaVersion": 1,
  "runIdentifier": "e2e01-01-20260912T035944Z",
  "commit": { "hash": "4749e5dd4d2992b846532adf2712804067732b67", "branch": "main", "isDirty": true },
  "tarball": { "sha256": "be07c8ab…0f6f", "sizeBytes": 621004 },
  "configuration": { "sha256": "dba5b87eec379be7a26d4fc7a9b44992c057e4247f64beb22840e2a25b865eee" },
  "provider": { "providerProfileId": "local-scripted", "modelProfileId": "scripted-mock-v1", "kind": "mock", "credentialsAuthorized": false },
  "platform": { "os": "win32", "osVersion": "10.0.26100", "nodeVersion": "24.18.0" },
  "fixtureFingerprint": "sha256:6512b2a6…4c7c",
  "automatedChecks": [{ "checkIdentifier": "e2e01-fixture-baseline-and-solution", "exitCode": 0, "status": "passed" }],
  "manualChecks": [
    { "checkIdentifier": "manual-user-workflow-walkthrough", "status": "pending-manual" },
    { "checkIdentifier": "manual-real-provider-observation", "status": "pending-manual" }
  ]
}
```

## 4. fixture 契约测试（先写反例）

`tests/core/integration/e2e01-fixture-contract.test.ts` 6 例（实现前全部失败）：

1. 两次 scaffold 指纹一致且包含冻结桩/失败测试/参考实现。
2. 场景身份要求（实现-测试-验收不同、强制一次返修）、权限（禁止安装）、预算（4096）、人工验收策略（block-until-verified）、资源盘点（无依赖/无网络）。
3. 基线稳定失败并打印冻结失败标记。
4. 参考实现通过并产出与冻结预期一致的产物（含产物哈希）。
5. 完整证据包通过校验，且 tarball 哈希/commit/配置/Provider/运行 ID 确实绑定。
6. 拒绝：缺失 `tarball.sha256`、真实 Provider 未授权（`real-provider-requires-authorization`）、人工项置 verified 但无 `verifiedByUserId`、自动项 `passed` 但退出码非 0、证据含疑似凭据字段。

## 5. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；172 文件 / 1488 用例通过 |
| `npm run test:coverage` | exit 0；172 文件 / 1488 用例通过；全局 93.73% stmts / **86.58% branch** / 91.66% funcs / 93.77% lines（≥85% 阈值）。修复固定 60 秒续接上限后复跑全绿；修复前两次覆盖率运行分别暴露 `cli-commands` run 用例与 `recovery-process-handoff` 的负载性误报 |
| `npm run verify:e2e01` | exit 0（§3） |
| `evidence-create` / `evidence-validate` | exit 0 / 校验通过 |
| 聚焦（含 spawn 的三套） | `e2e01-fixture-contract` 6/6、`recover-resume-execute` 4/4、`recovery-process-handoff` 2/2 |

## 6. 剩余/后继

- **E2E-01-02 确定性纵向闭环**：在本 fixture 上执行 侦察→规划→实现→测试→独立验收→返修→次级集成→主报告，需真实产物与角色身份证据。
- **E2E-01-03 真实服务与并行中断**：需要用户真实 Provider 凭据与费用授权（当前缺失，该检查点保持 blocked/pending）。
- **E2E-01-04 质量与交付声明**：check/coverage/关键模块专项/tarball 回归 + 平台与人工结论。
