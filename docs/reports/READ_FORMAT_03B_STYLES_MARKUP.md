# READ-FORMAT-03b CSS/SCSS/Less、HTML 与 Vue/Svelte 区段分派 — 证据

> 检查点：READ-FORMAT-03b（README-FORMAT-03 的样式/标记子检查点）
> 前驱：READ-FORMAT-03a（提交 3b5a9dd、2787be4、2e2ca12，已推送）。日期：2026-09-16
> 契约：docs/adr/0042-read-format-strategy-and-receipt.md（§14 为实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/tools/read-format/read-format-frontend-styles.ts（新） | CSS/SCSS/Less 扫描：块注释（CSS）与行注释（SCSS/Less）、url(...) 片段保护、@import/@use/@forward 省略 |
| packages/core/src/tools/read-format/read-format-frontend-markup.ts（新） | HTML 注释与静态资源标签（script src / link href）省略；顶层 template/script/style 区段分派到 markup/脚本/样式策略并做行号偏移 |
| packages/core/src/tools/read-format/read-format-strategies.ts | 注册 style-sheet（.css/.scss/.less/.sass）、html（.html/.htm）、vue（.vue）、svelte（.svelte） |
| tests/fixtures/read-format/frontend/**（新 5 夹具） | sample.css、sample.scss、sample.html、sample.vue、sample.svelte |
| tests/core/unit/read-format-frontend-mixed.test.ts（新，9 用例） | 注册与默认、样式、HTML 区段分派、Vue/Svelte、parse-error |

## 2. 行为反例（真实夹具，先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| CSS @import 与注释 | 按需省略 | 通过：@import、块注释、尾随注释均省略 |
| CSS url(https://…//…) | 不误删 | 通过：url(https://example.com/a//b.png) 保留 |
| CSS 字符串里的块注释标记 | 不误删 | 通过：字符串里的块注释标记保留 |
| SCSS 行注释与 @use/@import | 按需省略 | 通过：行注释、@use、@import 省略；url 保留 |
| HTML 注释与静态资源标签 | 按需省略 | 通过：头部注释、link href、script src 均省略 |
| HTML 嵌入 style 区段 | 按 CSS 策略过滤 | 通过：嵌入样式注释省略；url 保留 |
| HTML 嵌入 script 区段 | 按脚本策略过滤 | 通过：嵌入脚本注释省略；字符串与代码保留 |
| 区段行号偏移 | 行号对齐源文件 | 通过：样式注释命中第 8 行、脚本注释命中第 14 行；lineMap 19 行 |
| Vue 模板/脚本/样式区段 | 分别过滤、表达式保留 | 通过：三类注释省略；data-url、{{ count }}、字符串与 url 保留 |
| Svelte 区段 | 分别过滤、表达式保留 | 通过：三类注释省略；<div data-url={url}>{count}</div> 保留 |
| 默认参数 | 逐字节等于原文 | 通过：5 个夹具均 viewText === sourceText |
| HTML 未闭合注释 | 原样 + parse-error | 通过：isFilterable=false |
## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npx vitest run tests/core/unit/read-format-frontend-mixed.test.ts --maxWorkers=4 | 0；9 passed |
| npx tsc --noEmit / npx eslint . | 0 / 0 |

## 4. 设计边界

- 区段识别为轻量配对：顶层 <template>/<script>/<style> 与最近的同名闭合标签配对；
  脚本字符串里出现字面 </script> 的极端情形未做完整 JS 字符串感知（会在该处提前结束区段）。
- 带 src 的 script/style 视为资源引用标签而非区段（避免与后续闭合标签错配），由 markup 的静态资源标签规则处理。
- 区段内容分别走脚本/样式扫描器，因此嵌入代码不会因 HTML 注释规则被误删。
- readFile 参数与 receipt 透出仍属 READ-FORMAT-05。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npx tsc --noEmit / npx eslint . | 0 / 0（本轮实测） |
| npx vitest run tests/core/unit/read-format-frontend-mixed.test.ts --maxWorkers=4 | 0；9 passed（本轮实测） |
| npm run build | **未执行**：升级审批通道本轮连续停滞（见下） |
| npx vitest run --maxWorkers=6 | **未执行**：同上 |
| npx vitest run --coverage --maxWorkers=6 | **未执行**：同上 |
| npm run verify:security-coverage | **未执行**：依赖覆盖率摘要 |
| git push | 见提交记录 |

> 门禁未完成说明：受限沙箱下 vitest forks 池与 tsup 构建需要升级（danger-full-access），本轮该审批通道连续
> 多次在 600s 墙钟内未获批准而终止（共 5 次：2 次定向测试、3 次全量门禁）。定向测试与 tsc/eslint 已在批准通道
> 可用时实测通过；**全量门禁与覆盖率标记为未运行**，下一轮必须补跑并记录，不得以未运行冒充通过。

## 6. 未满足项与后续

- READ-FORMAT-04：LaTeX、配置/文档与其他语言（转义百分号、verbatim、Markdown 围栏、Shell heredoc、方言不支持）。
- READ-FORMAT-05：读取缓存、防重复读取、产品入口与 tarball（readFile 参数与 receipt 透出、补读、跨 Agent 隔离、资源测量）。
- 治理文档统一修订未开始。

