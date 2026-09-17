# READ-FORMAT-04b Go、Shell、SQL — 证据

> 检查点：READ-FORMAT-04b（READ-FORMAT-04 的其他语言子检查点，收口 READ-FORMAT-04）
> 前驱：READ-FORMAT-04a（提交 7114f39、a0b612c，已推送）。日期：2026-09-16
> 契约：docs/adr/0042-read-format-strategy-and-receipt.md（§16 实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/tools/read-format/read-format-other-languages.ts（新） | Go（解释/原始/符文字符串、import 单条与块）、Shell（# 注释、引号与反引号、heredoc、source/. 静态与动态）、SQL（-- 与块注释、单引号双写转义、双引号标识符） |
| read-format-strategies.ts | 注册 go（.go）、shell（.sh/.bash/.zsh）、sql（.sql） |
| tests/fixtures/read-format/config/sample.go/.sh/.sql（新 3 夹具） | 真实夹具 |
| tests/core/unit/read-format-other-languages.test.ts（新，11 用例） | 三种语言反例与边界 |

## 2. 行为反例（真实夹具，先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| Go import 单条与 import (…) 块 | 可按需省略 | 通过 |
| Go 解释/原始/符文字符串里的标记 | 不误删 | 通过：URL、`//…`、runr 与转义引号保留 |
| Go import 块后同行代码 | 保留并标注 | 通过：import-with-inline-code |
| Go 未闭合原始字符串 | 原样 + parse-error | 通过 |
| Shell # 注释（行首/空白后） | 按需省略 | 通过：顶层与尾随注释省略 |
| Shell heredoc（<<、<<-、带引号定界符） | 整体保留 | 通过：井号与 URL 保留 |
| Shell 单/双引号与反引号内容 | 不误删 | 通过 |
| Shell 静态 source/. | 可按需省略 | 通过 |
| Shell 动态 source（$VAR/$(…)/通配） | 保留并标注 | 通过：dynamic-import、partially-filtered |
| Shell 未闭合 heredoc/引号 | 原样 + parse-error | 通过 |
| SQL -- 与块注释 | 按需省略 | 通过 |
| SQL 字符串（'' 转义）与双引号标识符 | 不误删 | 通过 |
| SQL 未闭合字符串/块注释 | 原样 + parse-error | 通过 |
| SQL imports 与方言 | 标注不适用与局限 | 通过：imports-unsupported、dialect-comment-variants |
| 默认参数 | 逐字节等于原文 | 通过 |
## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npx vitest run tests/core/unit/read-format-other-languages.test.ts --maxWorkers=4 | 0；11 passed |
| npx tsc --noEmit / npx eslint . | 0 / 0 |

## 4. 设计边界

- Shell heredoc 识别要求 << 后为字母/引号定界符；$((1 << 2)) 等无空格左移不会被当 heredoc。
- Shell source/. 仅当参数为纯路径（无 $、反引号、括号、通配）时视为静态导入；动态加载保留并标注，不冒充静态导入。
- SQL 只保证 -- 与块注释；方言特有注释（如 MySQL #）未处理并显式标注 dialect-comment-variants。
- 字符串跨行在 SQL 中未支持（视为 parse-error 原样返回）。
- READ-FORMAT-04（LaTeX、配置/文档、其他语言）至此全部收口；readFile 参数与 receipt 透出仍属 READ-FORMAT-05。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：219 文件 / 1776 用例全通过（+1 文件 / +11 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 93.01 / 85.11 / 93.01 / 93.04；tools/read-format 92.23 / 84.75 / 98.80 / 92.15；other-languages 93.67 / 84.06 / 100 / 93.58 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | 见提交记录 |

> 过程记录：首轮全量覆盖率因新模块分支覆盖不足报 branch 84.95% < 85%（阈值失败，exit 1）；
> 补充 heredoc/引号/动态 source/SQL 未闭合等边界用例后 branch 回到 85.11%，门禁恢复 exit 0。未放宽阈值。

## 6. 未满足项与后续

- READ-FORMAT-05：读取缓存、防重复读取、产品入口与 tarball（readFile 参数与 receipt 透出、补读、跨 Agent 隔离、资源测量）。
- GUIDE 增量（用户文档 §6）在相关权限/版本契约确定后接入。
- 治理文档统一修订未开始。

