# STATUS_UPDATE：T07D Provider 协议**产品接线现状**与既有报告表述的漂移（2026-11-08，第 108 轮）

- **性质**：**状态补丁**。按 `AGENTS.md`「共享文件不能安全修改时创建独立
  `docs/reports/STATUS_UPDATE_<任务ID>_<日期>.md` 状态补丁并说明待集成，**不覆盖他人修改**」
  —— 本文件**未修改**任何历史报告，只记录现状与漂移，**待集成**。
- **触发**：第 108 轮产品可达性核实（`docs/reports/PRODUCT_REACHABILITY_AUDIT_2026-11-08.md`）中，
  我一度把"Azure/Bedrock 适配器不可达"当作**新**缺口，查证后发现**既有报告早已记录**；
  但同一批表述里**有一句已经过期** ⇒ 记此补丁。

## 1. 既有表述（原文，带位置）

| 文件 | 行 | 原文要点 |
| --- | --- | --- |
| `docs/reports/PRODUCT_PATH_ACCEPTANCE_DUAL_VENDOR_2026-10-02.md` | 104–105 | 「**非 OpenAI 兼容协议**：`anthropic-messages`、`gemini-interactions`、`bedrock-converse`、`azure-openai` —— 适配器代码存在，但 **CLI 的 `run` 只注册 `openai-compatible`**」 |
| `docs/reports/T07D_R2_01_PROVIDER_BASELINE.md` | 13 | 厂商适配器「各自契约/单元级已验证，**产品接线未接**」 |
| `PLAN_STATUS.md` | 1481 | 「仅 `anthropic-messages` 与 `openai-compatible` 接入 usage，其余适配器（responses/gemini/bedrock/azure）未采集」 |

## 2. 现在的事实（可复跑）

**`packages/tui/src/cli/runtime-selection.ts` 有两处注册点，都是"按所选协议二选一"**：

- L124–129（凭据引用路径）：
  `resolveProviderProtocol(options.providerProtocol)` ⇒ 若为 `"anthropic-messages"`
  则 `registry.register(createAnthropicMessagesProviderRegistration())`，**否则**
  `registry.register(createOpenAiCompatibleProviderRegistration())`；
- L199–204（无凭据引用路径）：同样二选一。

且两个注册器都**已从公开门面导出**（`packages/core/src/public-sdk.ts`
的 `createOpenAiCompatibleProviderRegistration` 与 `createAnthropicMessagesProviderRegistration`），
门面也接受 `providerRuntimeRegistry?`（可由宿主注入）。

## 3. 漂移的**精确范围**（不夸大）

- **`anthropic-messages`：已接产品**（上面的二选一分支 + 门面导出）⇒
  上述「**CLI 的 `run` 只注册 `openai-compatible`**」**对 Anthropic 已不成立**；
- **`gemini` / `bedrock-converse` / `azure-openai`：仍未接**（本轮 ripgrep 核实：
  `AzureOpenAiAdapter`／`BedrockConverseAdapter` 在 `packages/` 内**只出现在各自文件**，
  既未注册、也**未从公开门面导出** ⇒ **产品与宿主都无法使用**）
  ⇒ 既有「产品接线未接」的结论**对其余三个仍然成立**。

**⇒ 结论是"部分过期"，不是"整句错"**：既有报告的作者当时的判断无误，
只是此后 Anthropic 那条接通了（另有 `PRODUCT_PATH_ACCEPTANCE_ANTHROPIC_UNISOUND_2026-10-02.md`
专门记录该次接入）⇒ 需要的是**加日期化说明**，而不是改写历史结论。

## 4. 待集成

- 本补丁**没有**修改 `PRODUCT_PATH_ACCEPTANCE_DUAL_VENDOR_2026-10-02.md`／
  `T07D_R2_01_PROVIDER_BASELINE.md`（他人产出，按 §8.4 不覆盖）；
- 建议由对应卡所有者把「Anthropic 已接、其余三个仍未接」并入那些文档，
  或保留本补丁作为现状说明即可。

## 5. 可复跑证据

```powershell
# ① 生产只注册两条协议（二选一）
Select-String -Path packages/tui/src/cli/runtime-selection.ts -Pattern "register\(create"
# ② Azure/Bedrock 适配器在生产里只出现在自身文件（应只命中文件自身）
rg -n "AzureOpenAiAdapter|BedrockConverseAdapter" packages
# ③ 门面是否导出（决定宿主能否自行注册）
rg -n "createAnthropicMessagesProviderRegistration|createOpenAiCompatibleProviderRegistration" packages/core/src/public-sdk.ts
```
