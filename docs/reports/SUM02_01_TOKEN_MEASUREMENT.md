# SUM-02-01 token 计量适配端口与来源 schema — 证据

> 检查点：SUM-02-01（docs/tasks/SESSION_SUMMARY_AND_STEERING_TASK_CARDS.md，未跟踪用户文件）
> 前驱：SUM-01（全部检查点 done）。日期：2026-09-15
> 契约冻结：docs/adr/0035-token-measurement-adapters.md

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/measurement/token-measurement.ts`（新） | 来源 schema（provider-usage/local-tokenizer/conservative-estimate）、版本字段（provider/model/tokenizer/序列化版本）、`estimateTokensConservatively`（`conservative-estimate-v1`，确定性）、`TokenMeasurementService`（本地适配器注册 + 选择 + 回落 + Provider usage 记录）、`isMeasurementReusableFor`（版本复用判定） |
| `tests/core/unit/token-measurement.test.ts`（新，6 用例） | 中英文/emoji/代码/数学样本、适配器命中与回落、非本地拒绝、版本复用、无统一换算声明、静态无网络扫描 |

## 2. 行为反例（先写反例，红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 用某次 token 数充当通用事实（跨模型/序列化复用） | 版本不一致不可复用 | ✅ 序列化版本 +1 → `isMeasurementReusableFor=false`；本地 tokenizer 版本不一致同样 false |
| 未知 tokenizer 被猜测或默认按"字符数=token" | 保守估算 + 明确回落原因 | ✅ `tokenizer-not-registered` / `no-tokenizer-declared`，估算来源 `conservative-estimate` |
| 保守估算低估（导致后续截断） | 不低估 | ✅ 5 类样本（中英混排/纯中文/emoji 含 ZWJ 与肤色/代码/数学单位）估算 ≥ `ascii/4` 且 ≥ 非 ASCII 码位数，且同输入同输出 |
| 声称统一字符/token 准确率 | 无此类字段/常量 | ✅ 模块导出无 `perChar`/`tokensPer` 命名，DTO 无 `charactersPerToken`，估算 `accuracyClaim="none"` |
| 适配器偷偷联网计量 | 只允许本地实现 | ✅ 注册 `adapterKind:"remote"` → `non-local-adapter-rejected`；静态扫描确认模块无 `node:http(s)`/`fetch(`/axios/undici |
| Provider usage 被当成"本地测量" | 权威来源单列 | ✅ `isAuthoritative=true`、`accuracyClaim="provider-reported"` |
| 空文本产生无意义计量 | 显式拒绝 | ✅ `invalid-measurement-input` |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/unit/token-measurement.test.ts` | 0；**6 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 见 §4 |
| `npm run check` / `test:coverage` / `git push` | 见 §4 |

## 4. 门禁与推送

（本轮复跑后回填。）

## 5. 未满足项与后续

- SUM-02-02：完整请求计量与包装/输出预留，选入完整记录，模型切换重新计量；只分页不裁剪存档摘要。
- SUM-02-03：权威字段本地提取与叙述引用证据（对照原文检查事实支持/遗漏/错误归因）。
- SUM-02-04：内容缓存与计量缓存分离、真实产品请求捕获与 tarball 联测、人工标注质量评估。
- 本地 tokenizer 适配器首期未注入具体实现（等待真实 Provider 侧 tokenizer 资源与安装门禁授权）。
