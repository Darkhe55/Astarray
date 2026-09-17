# READ-FORMAT-04a LaTeX 与配置/文档格式 — 证据

> 检查点：READ-FORMAT-04a（READ-FORMAT-04 的 LaTeX 与配置/文档子检查点）
> 前驱：READ-FORMAT-03b（提交 d57ec34、1aad551，已推送）。日期：2026-09-16
> 契约：docs/adr/0042-read-format-strategy-and-receipt.md（§15 为实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/tools/read-format/read-format-latex.ts（新） | LaTeX 扫描：% 注释（转义 \% 不算）、verbatim/lstlisting/minted 等逐字环境整体保留、usepackage/input/include 省略、未闭合逐字环境 parse-error |
| packages/core/src/tools/read-format/read-format-config-documents.ts（新） | JSON/JSONC、YAML、TOML、Markdown、纯文本策略；imports 能力标 unsupported |
| read-format-scanner.ts | 新增 shouldTreatAsLineComment 钩子（YAML 的 # 需行首/空白后） |
| read-format-strategies.ts | 注册 latex/jsonc/json/yaml/toml/markdown/plain-text |
| tests/fixtures/read-format/config/**（新 6 夹具） | sample.tex/.yaml/.jsonc/.toml/.md/.txt |
| tests/core/unit/read-format-config-documents.test.ts（新，10 用例） | LaTeX、配置、Markdown、纯文本、parse-error |

## 2. 行为反例（真实夹具，先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| LaTeX 普通 % 注释 | 按需省略 | 通过 |
| 转义 \% | 不误删 | 通过：newcommand 的 100\% 保留 |
| verbatim / lstlisting | 整体保留（含 % 与伪 usepackage） | 通过 |
| usepackage[..]{..}/input | 可按需省略 | 通过（修复命令参数多组消费） |
| 未闭合 verbatim | 原样 + parse-error | 通过 |
| YAML # 注释 | 按需省略 | 通过：顶层与尾随注释省略 |
| YAML URL 片段 # | 不误删 | 通过：url: https://example.com/a#fragment 保留 |
| YAML 引号内 # | 不误删 | 通过 |
| JSONC 行/块注释 | 按需省略 | 通过：URL 里的 // 保留 |
| TOML # 注释 | 按需省略 | 通过 |
| JSON 无注释能力 | 原样 + 标注不适用 | 通过：comments-unsupported / imports-unsupported |
| Markdown HTML 注释 | 按需省略 | 通过：文档注释与行内注释省略 |
| Markdown 围栏代码块 | 整体保留 | 通过：围栏内 // 与 URL 保留 |
| Markdown 未闭合注释 | 原样 + parse-error | 通过 |
| 纯文本 | 原样 + 标注不适用 | 通过 |
| 默认参数 | 逐字节等于原文 | 通过（修复 Markdown 注释未按参数门控） |
## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npx vitest run tests/core/unit/read-format-config-documents.test.ts --maxWorkers=4 | 0；10 passed |
| npx tsc --noEmit / npx eslint . | 0 / 0 |

## 4. 设计边界

- 不支持、解析失败或能力不足都显式标注：JSON/纯文本 comments-unsupported，全部无导入概念格式 imports-unsupported。
- LaTeX 只做文本级：不执行宏、不展开 \input 目标；逐字环境按环境名整体保留。
- Markdown 只识别围栏代码块与 HTML 注释；行内代码里的 <!-- 不作为例外（如实按注释处理）。
- Go/Shell/SQL 属 READ-FORMAT-04b；readFile 参数与 receipt 透出仍属 READ-FORMAT-05。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：218 文件 / 1765 用例全通过（+1 文件 / +10 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 92.98 / 85.09 / 92.92 / 93.01；tools/read-format 91.73 / 84.67 / 98.55 / 91.65；read-format-latex 92.90 / 78.02 / 100 / 92.75；config-documents 98.19 / 92.50 / 100 / 98.16 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | 见提交记录 |

## 6. 未满足项与后续

- READ-FORMAT-04b：Go、Shell、SQL（heredoc、方言不支持等边界）。
- READ-FORMAT-05：读取缓存、防重复读取、产品入口与 tarball。
- 治理文档统一修订未开始。

