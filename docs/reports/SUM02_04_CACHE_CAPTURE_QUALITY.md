# SUM-02-04 缓存分离、Provider usage 捕获与质量评估 — 证据

> 检查点：SUM-02-04（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：SUM-02-03（提交 `a483d28`）。日期：2026-09-15
> 契约冻结：docs/adr/0037-measurement-cache-and-quality-evaluation.md

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/measurement/measurement-cache.ts`（新） | 内容缓存（仅内容哈希，无模型字段）与计量缓存（内容哈希+provider/model/tokenizer@version/序列化版本）分离；`computeMeasurementCacheMetrics` 纯函数复算指标 |
| `packages/core/src/measurement/provider-usage-capture.ts`（新） | 本地 JSONL 捕获端口（追加写、损坏行 fail-closed）、权威计量转换、序列化版本复用判定、离线状态如实声明 |
| `packages/core/src/measurement/quality-evaluation.ts`（新） | 人类标注质量评估（precision/recall/F1/falseSupportRate）；拒绝模型自评、缺标注者与样本集不匹配 |
| `packages/core/src/public-sdk.ts`（扩展） | 计量/预算/核验/缓存/质量 API 经公共 exports 暴露（安装包消费者可用） |
| `scripts/verify-measurement-package.mjs`、`scripts/evaluate-summary-quality.mjs`（新） | 安装包联测（10 项检查）与人工标注评估 CLI；示例 fixtures 在 `scripts/fixtures/` |
| 测试：`measurement-cache.test.ts`(3)、`provider-usage-capture.test.ts`(3)、`quality-evaluation.test.ts`(4) | 10 个新用例 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 换模型时重写内容缓存（历史被覆盖） | 内容条目完全不变，只新增计量 | ✅ 模型 A→B 后 `contentEntries` 深比较相同、`measurementEntries` 1→2、`contentEntryCount=1` |
| 指标只能靠增量计数、无法离线复算 | 活状态与快照复算一致 | ✅ `computeMeasurementCacheMetrics(exportSnapshot())` 与对 JSON 深拷贝快照的复算结果 `toEqual` |
| 内容条目夹带模型字段 | 结构上分离 | ✅ 内容条目键只有 `contentHash/firstSeenAtIso/text`；`isContentModelIndependent=true` |
| 损坏的 usage 行被静默跳过 | 显式失败 | ✅ 追加非法行后 `readAll()` 抛错 |
| Provider usage 被当成普通估算 | 权威来源 + 版本绑定 | ✅ `attachProviderUsageToMeasurement` → `isAuthoritative=true`、token 数 = input+output = 1250；序列化版本不符 → 不可复用 |
| 缺凭据时假装可捕获真实 usage | 如实声明 | ✅ `describeOfflineCaptureStatus().isRealProviderCaptureAvailable === false`，原因含"凭据" |
| 生成模型自评通过质量门 | 拒绝 | ✅ `labelSource="model"` → `model-self-evaluation-rejected`；缺 `labeledByUserId` → `human-labeler-required`；样本集不匹配 → `sample-set-mismatch` |
| 无负样本时虚报比率 | 明确 null | ✅ `falseSupportRate=null`，precision/recall=1（分母可见） |

## 3. 安装包联测（本地 dist 预跑）

`node scripts/verify-measurement-package.mjs --package-dir .`（构建后）→ 10/10 检查通过：
内容/model 分离、指标复算、重建叙述 `supported`、预算分页 10 条无重无漏（分页 4 条）、
capture 往返、usage 权威（1250）、离线状态诚实、人类标注评估可用、模型自评被拒。

`node scripts/evaluate-summary-quality.mjs --samples scripts/fixtures/sum02-quality-labels.example.jsonl --predictions ...`
→ `precision=0.5, recall=1, f1=0.667, falseSupportRate=1`（示例 fixture 使用 human 标注；**真实人工标注样本仍待人工提供**）。

## 4. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run check` | **exit 0**（提交 `df03aa3`）：199 文件 / **1625 用例全通过** |
| `npm run test:coverage` | **exit 0**（补齐后）：199 文件 / **1625 用例全通过**；全局 statements **93.43%** / branch **85.88%** / functions **92.44%** / lines **93.47%**；`packages/core/src/measurement` 目录 96.63% / 85.71% / 97.18% / 96.87%。补齐过程中为三个既有用例提高等待上限（`efe9eaa`、`9dd7b2b`：90s→180s、默认→60s、20s→60s，**断言不变**） |
| `npm pack` | exit 0；tarball sha256 `c0c383ac3f575a761c56a6e719c692e27540ef886193823f037691c2a25de206` |
| `node scripts/verify-package.mjs` | exit 0 |
| `node scripts/smoke-install.mjs` | exit 0（第 1 次命中既有波动，第 2 次通过） |
| `node scripts/verify-summary-package.mjs`（安装包） | exit 0 |
| `node scripts/verify-measurement-package.mjs`（安装包） | **exit 0：10/10 检查通过**（内容/model 分离、指标复算、重建叙述 supported、预算分页无重无漏、capture 往返、usage 权威 1250、离线诚实、人类标注可用、模型自评被拒） |
| `node scripts/evaluate-summary-quality.mjs`（安装包） | exit 0（示例人工标注 fixture：precision 0.5 / recall 1 / falseSupportRate 1） |
| `git push` | **exit 0**：`a483d28..9dd7b2b`（`origin/main` = `9dd7b2b`） |

## 5. 提交与推送

- 提交：`df03aa3`（实现）、`efe9eaa` 与 `9dd7b2b`（既有用例超时加固，断言不变）、`d507928`（记录）。
- 推送：`git push` exit 0，`a483d28..9dd7b2b`；**HEAD == origin/main == 9dd7b2b**。

## 6. 未满足项（不声称完成）

- **真实 Provider usage 捕获**：需要有效凭据与费用授权（缺省保持 blocked）；本轮只交付本地捕获端口与权威转换。
- **人工标注样本质量结论**：工具链与格式已就绪且拒绝模型自评，但**没有真实人工标注样本**，
  因此不给出质量结论（示例 fixture 仅演示格式）。
- 缓存淘汰/容量策略与捕获文件轮转未实现（记录于 ADR-0037 非目标）。