# 413 卡死根因：`session-log-deepseek` 水位缺失 → 每次请求重发整份会话日志（上游已知缺陷）

- 日期：2026-09-27
- 本机：`@deepseek-ai/dsh` **0.1.7-rc.1**（`dsh-session-log-deepseek` 同版本），Windows / Node v24.18.0
- 结论：**这不是上下文过大，也不是 provider 体积上限本身，而是上游已知缺陷**
  [#7658](https://github.com/deepseek-ai/deepseek-harness/discussions/7658)（主帖）
  与 [#7753](https://github.com/deepseek-ai/deepseek-harness/discussions/7753)（补充帖）的同一根因，
  **已在 `dsh-v0.1.7-rc.2` 修复**。
- 本文取代此前 `DSH_413_REQUEST_TOO_LARGE_FINDING_2026-09-27.md` 的诊断
  （那份把 413 归因于"上下文/请求体自然增长"，结论错误，已移入 `.tmp/superseded/`）。

## 1. 机制（一句话）

插件 `@deepseek-ai/dsh-session-log-deepseek` 会把**整份会话日志**作为顶层字段
`dsh_session_log` 塞进每一次 Messages 请求。当"接受水位"缺失时，
`afterSeq` 回退为 `-1` → 每次都从第 0 号事件开始发 → 请求体等于整份日志；
而水位**只在请求成功（2xx）后的 `accept()` 里写入**，所以 413 一旦发生就再也写不进水位 —— 永久自锁。

本机插件源码（`dsh-session-log-deepseek/lib/index.js`，0.1.7-rc.1）实测三处关键行：

```
L16 : const Config = z.object({ enabled: z.boolean().default(true) });   // 默认开启（0.1.5-rc.3 起前为 false）
L96 : if (acceptedFormatVersion !== session.header.version) continue;    // 水位按会话格式代际作用域
L127: const suffix = session.snapshotEvents(SessionLogOffset(afterSeq + 1));  // afterSeq=-1 → 整份日志
```

且该版本 `Config` **只有 `enabled` 一个字段，没有体积上限** —— 与上游 `README` 的
"No independent request-size cap / complete delivery is fail-closed" 一致。

## 2. 本机证据（自己扫描 `$DSH_HOME/sessions` 得到）

对每个会话逐帧解压（多帧 zstd）后统计 `delivery-accepted` 事件数与解压体积：

| 会话 | 事件数 | 接受水位 | 解压体积 |
|---|---:|---:|---:|
| `session-e905a5d7`（本次卡死的会话，v4） | 30,744 | **0** | **89.9 MB** |
| `session-e905a5d7`（v3 原始代际） | 30,711 | **0** | **89.9 MB** |
| `session-d0ac1817`（当前会话） | 620 | 97（throughSeq 615） | 2.6 MB —— 健康 |

- 卡死会话的水位为 **0**：`afterSeq = -1` → 每次请求附带约 **89.9 MB** 的日志字段。
- 上游实测 endpoint `https://api.deepseek.com/anthropic/v1/messages` 的体积阈值落在
  **8 MB 与 48 MB 之间**（8 MB → 200，48 MB → 413），89.9 MB 必然 413。
- 与"消息内容无关"的现象吻合：卡死三轮的输入分别只有「继续」和 goal-round 文本，仍然立即 413。

### 2.1 本机还有 16 个会话处于同一风险

水位为 0 且事件数 > 500 的会话（每个都只差"一次官方 DeepSeek 轮次"就会同样卡死）：

| 事件数 | 解压体积 | 会话（workspace 省略） |
|---:|---:|---|
| 30,744 / 30,711 | 89.9 MB | `session-e905a5d7`（已卡死） |
| 2,664 | 9.7 MB | `session-c204a250` |
| 2,353 | 8.5 MB | `session-d1deefdc` |
| 2,665 | 7.7 MB | `session-25cca76d` |
| 6,421 / 1,999 | 4.6 / 4.1 MB | `session-669c7477` |
| 634 | 3.6 MB | `session-2e6b3ce8` |
| 954 | 3.0 MB | `2a8088f1` |
| 7,226 | 2.7 MB | `session-de0ebd21` |
| 975 / 847 / 722 | 2.6 / 2.6 / 2.0 MB | `1e46fe85` / `c536e639` / `5bb14091` |
| 521 / 525 | 1.7 / 1.7 MB | `1ae85e3e` / `7fb5d071` |
| 378 | 1.5 MB | `session-de0ebd21`(v3) |

（体积越大越危险；几 MB 的会话会先付出一次超大上传，通常还能自行恢复增量。）

## 3. 与「400 CONTEXT_WINDOW_EXCEEDED」是两个独立问题

同一会话更早还有 5 次 `400 CONTEXT_WINDOW_EXCEEDED`
（`requested ≈1.05M = 793k messages + 256k completion > 1,048,576`）。那是**另一个**问题：
DSH 的 token 估算对中文内容偏低约 1.6 倍 + 每次预留 256k 输出，导致压缩阈值没被触发。
它由已落地的 `llm-deepseek` 容量配置缓解（见 §5），**但与 413 无关** —— 413 的请求里
`messages` 只占约 1.5 MB，罪魁是那个 89.9 MB 的 `dsh_session_log` 字段。

判据（上游补充帖给出）：**干净 413 → `INVALID_REQUEST` → 不重试**；
若是 `TRANSPORT` 则会重试 5 次、每轮重传整个字段 —— "有没有被重试"本身就是判别器。

## 4. 修复

### 4.1 首选：升级到 `0.1.7-rc.2`（已含修复，本机可核实）

- npm dist-tags 实测：`latest = 0.1.5-rc.3`、`alpha = 0.1.7-alpha.2`、**`next = 0.1.7-rc.2`**（本机当前为 `0.1.7-rc.1`）。
- 修复提交 `193f9ce413`（PR #5168）：*fix(llm): keep oversized request extensions from blocking model requests*。
  `dsh-v0.1.7-rc.2` 源码中该插件新增：

  ```
  maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024),
  // A request uploads the longest pending event prefix that fits; later requests continue
  ```

  即改为"只发水位之后能装下的最长前缀并推进水位"，单个事件超限时省略字段并告警。
- 升级命令：`npm i -g @deepseek-ai/dsh@next`
- **本机已于 2026-09-27 执行完毕**：`0.1.7-rc.1` → **`0.1.7-rc.2`**（实测 `package.json` 版本与插件版本均为 rc.2）。
  复核证据：`dsh-session-log-deepseek@0.1.7-rc.2` 的 `lib/index.js:19` 为
  `maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024)`，另有 `L161 if (candidateBytes > maxBytes) break`
  与 `L170` 的超限告警分支；`llm-deepseek` 的 Config 仍接受 `maxTokens` / `defaultContextWindow` / `models`
  （`lib/index.js:319-321`），故既有 profile 补丁无需改写。
- 升级后**卡死的会话可直接复活**（下次请求体 ≈ 1.5 MB messages + ≤8 MB 日志）。
  注意排水过程：89.9 MB 的积压按"每请求 ≤8 MiB"推进，约需十余轮才追平水位，其间会话可正常应答。
- ⚠️ **必须重启 `dsh web` 才生效**：正在运行的进程内存里仍是 rc.1 的代码。
- 安装告警说明：npm 的 `allow-scripts` 拦下 5 个包的安装脚本，其中唯一相关的
  `@deepseek-ai/dsh-subprocess-local` 的 postinstall 是 `ensure-spawn-helper.mjs`——它只对 node-pty 的
  **POSIX** 预编译 helper 执行 `chmod 755`，在 Windows 上是空操作；原生模块均来自平台预编译包
  （`@koromix/koffi-win32-x64`、`@img/sharp-win32-x64`、`node-pty/prebuilds/win32-x64/*.node`），
  实测均在位，可忽略该警告。

### 4.2 ≤ `0.1.7-rc.1` 的临时手段：关掉该附加项

必须打在 **home 层**（`$DSH_HOME/cordis.patch.yml`）才能同时覆盖 `web` / `tui` / `headless`
（本机该文件目前**不存在**，需新建；只改 `profiles/web/cordis.patch.yml` 盖不住其它 profile）：

```yaml
- id: session-log-deepseek
  config:
    enabled: false
```

代价：模型失去"按需读取原始会话日志"的能力。回滚＝删掉这三行（或改回 `true`）并重启 DSH。
注意 rc.1 的 `Config` 没有 `maxBytes`，所以此版本无法"限量发送"，只能开/关。

生效时机：Cordis 补丁层在启动时读取，**需要重启 DSH**。

## 5. 已落地的旁路配置（缓解 400 类，不修 413）

`~/.dsh/profiles/web/cordis.patch.yml` 已写入；升级前用 `dsh --profile web --dump-config` 两次确认合成结果，
升级到 rc.2 后用静态检查复核（配置 schema `lib/index.js:319-321` 仍接受这三个键、base 侧 `id: llm-deepseek` 行未改名）。

```yaml
- id: llm-deepseek
  config:
    maxTokens: 32000            # 默认 256000，不再用 256k 输出预留挤占窗口
    defaultContextWindow: 400000
    models: [deepseek-flash → 400000, deepseek-v4-pro → 400000]
```

效果：压缩阈值 `min(400000×0.8, 400000−32000−65536) = 302,464`（DSH 估算 token；
换算实际约 48 万），远低于此前触发 400 的 ~79 万真实 token。若嫌压缩过于频繁，可把
`contextWindow` 调回 `600000`（阈值 480,000 估算）。

## 6. 上游现状与提交建议

- 主帖 [#7658](https://github.com/deepseek-ai/deepseek-harness/discussions/7658)：
  格式迁移后水位失效；主帖下已有 4 条独立复现（含 `argszero` 的源码复核与 `donyue7` 的实测数据）。
- 补充帖 [#7753](https://github.com/deepseek-ai/deepseek-harness/discussions/7753)：
  `enabled` 默认值翻转起点（`dsh-v0.1.6-alpha.1`）、`TRANSPORT` vs 413 的判别、home 层 workaround、一键脚本。
- 相关但不同：[#7699](https://github.com/deepseek-ai/deepseek-harness/discussions/7699)（遥测字段把请求体撑到 205.87 MB）、
  [#2865](https://github.com/deepseek-ai/deepseek-harness/discussions/2865)、[#5263](https://github.com/deepseek-ai/deepseek-harness/discussions/5263)。
- 官方要求：`CONTRIBUTING.md` 明确"缺陷请发 GitHub Discussions"（不接受外部 PR）；该仓库
  **Issues 与 PR 均已关闭**，只有 Discussions 可用。
- ⚠️ **不要新开主题帖**：[#7736](https://github.com/deepseek-ai/deepseek-harness/discussions/7736)
  曾因与 #7658 重复而被撤回。合适做法是给 #7658 **点赞（+1）**，并用评论补充本机独立证据。

### 附：可粘贴到 #7658 的评论草稿（已脱敏）

```markdown
Independent data point on the **"watermark was never established"** path (not the migration path), on
`0.1.7-rc.1` / Windows / `deepseek-official` + `deepseek-flash`, endpoint `https://api.deepseek.com/anthropic`.

Symptom matched the report exactly: after upgrading, the first message in an old long session
(the literal text "继续", two characters) failed instantly and deterministically:

    {"message":"DeepSeek Messages request failed (413)","code":"INVALID_REQUEST","status":413}

and it repeated on every subsequent turn with no `llm/retry` event in between (INVALID_REQUEST is not retryable).

Local evidence (all frames of the multi-frame zstd log decoded, `delivery-accepted` counted per session):

| | events | accepted watermark | decompressed log |
|---|---:|---:|---:|
| stuck session (v4) | 30,744 | **0** | **89.9 MB** |
| same session (v3 generation) | 30,711 | **0** | **89.9 MB** |
| a session created after the upgrade | 620 | 97 (throughSeq 615) | 2.6 MB |

So `afterSeq = -1` and every request carried the whole log (89.9 MB) — well past the ~8–48 MB
ceiling, and consistent with "any content fails, size of the message is irrelevant".

Two things I could add to the thread:

1. The installed `dsh-session-log-deepseek@0.1.7-rc.1` has `Config = z.object({ enabled: z.boolean().default(true) })`
   — `enabled` only, **no `maxBytes`**, so on that version there is no way to send a bounded suffix.
2. The blast radius is not just the one session: of 29 session generations in this home, **16 have zero
   accepted watermarks and >500 events** (2.0–89.9 MB). They are all one official-DeepSeek turn away
   from the same deadlock, even though the plugin was never enabled deliberately.

Confirming the rc.2 fix path: `next = 0.1.7-rc.2` on npm, and `dsh-v0.1.7-rc.2`'s source carries
`maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024)` with the "longest pending prefix that fits"
behaviour from #5168 — so upgrading should both stop the new occurrences and let the stuck session drain.

Thanks for the source-level confirmations — they made this trivial to verify locally.
```
