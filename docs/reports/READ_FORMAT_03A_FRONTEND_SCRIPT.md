# READ-FORMAT-03a 前端脚本（JS/TS/JSX/TSX）读取策略 — 证据

> 检查点：READ-FORMAT-03a（READ-FORMAT-03 的前端脚本子检查点，用户文档允许族内再拆）
> 前驱：READ-FORMAT-02（提交 3eaf596、46b0054，已推送）。日期：2026-09-16
> 契约：docs/adr/0042-read-format-strategy-and-receipt.md（§13 为实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/tools/read-format/read-format-frontend-script.ts（新） | 前端脚本状态机：字符串/模板字符串（含 ${} 嵌套代码）、正则字面量、JSX 文本/标签/表达式容器、静态导入识别、动态 import() 保留标注、parse-error 诚实降级 |
| packages/core/src/tools/read-format/read-format-strategies.ts | 注册 frontend-script 策略（.js/.jsx/.ts/.tsx/.mjs/.cjs），supportsJsx 按后缀切换 |
| tests/fixtures/read-format/frontend/**（新，4 个真实夹具） | sample.tsx、sample.ts、sample.jsx、incomplete.tsx |
| tests/core/unit/read-format-frontend.test.ts（新，11 用例） | 注释安全、JSX 边界、导入与副作用、parse-error |
| tsconfig.json | exclude 增加 tests/fixtures（夹具是数据，不是可编译源码；incomplete.tsx 故意未闭合） |
| packages/core/src/orchestration/local-preservation-service.ts | 支撑修复：Windows 目录 rename 被短暂占用（EPERM/EBUSY/EACCES）时有界重试，仍失败即抛错不伪造成功（独立提交） |

## 2. 行为反例（真实夹具，先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 字符串里的双斜杠 | 不误删 | 通过：https://example.com/a//b 保留 |
| 模板字符串与 ${} 内代码 | 内容保留、表达式内注释按需省略 | 通过：value 模板保留；`a ${ b  } d` 注释被省、代码保留 |
| 正则字面量与转义斜杠 | 不误删 | 通过：https 正则、/a\/\/b/、/x\/\/y/ 保留 |
| 除法运算符 | 不被当正则 | 通过：count / 2 / 3 保留 |
| JSX 文本里的双斜杠 | 不误删 | 通过：文本行保留 |
| JSX 注释与表达式内块注释 | 按需省略、代码保留 | 通过：省略区间 18-19 行，<span>{count }</span> 保留 |
| JSX 属性表达式与自闭合标签 | 不误删 | 通过：className={styles.list}、<br /> 保留 |
| JSX 闭合标签后的代码 | 不被当成 JSX 文本 | 通过（修复闭合标签回落状态） |
| 比较小于号（非 JSX） | 不进入 JSX 模式 | 通过：1 < 2 保留 |
| 静态 import / export-from / require | 可按需省略 | 通过：多行 import、import "./styles.css"、require 均省略 |
| 动态 import() | 保留并标注 | 通过：import("./dynamic.js") 保留，retainedConstructs 含 dynamic-import，partially-filtered |
| 同行代码的 import | 不删除并标注 | 通过：保留并记 import-with-inline-code；视图等于原文时状态诚实为 not-filtered |
| 未闭合模板字符串 | 原样 + parse-error | 通过：unterminated-template-literal，isFilterable=false |
| 未闭合块注释 | 原样 + parse-error | 通过：unterminated-block-comment |
| 默认参数 | 原样返回 | 通过：viewText 等于 sourceText、not-filtered |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npx vitest run tests/core/unit/read-format-frontend.test.ts --maxWorkers=4 | 0；11 passed |
| npx vitest run tests/core/unit/read-format-frontend.test.ts tests/core/unit/read-format-strategies.test.ts --maxWorkers=4 | 0；23 passed（含 02 回归） |
| npx vitest run tests/core/integration/local-preservation.test.ts tests/core/integration/local-preservation-restore.test.ts tests/core/integration/local-preservation-product-entry.test.ts --maxWorkers=4 | 0；21 passed（rename 重试修复验证） |
| npx tsc --noEmit / npx eslint . | 0 / 0 |

## 4. 设计边界

- JSX 支持范围：文本、标签属性（含表达式容器）、自闭合与闭合标签；不承诺完整 TS/JSX 语法解析。
- 正则/除法歧义用前一个有效记号与关键字启发式；判定失败时按除法处理（保留，不误删）。
- CSS/HTML/Vue/Svelte 区段分派属 READ-FORMAT-03b；readFile 参数与 receipt 透出仍属 READ-FORMAT-05。
- 支撑修复不改变保全语义：rename 仍失败即抛错，不留在临时目录充当 ready。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：216 文件 / 1742 用例全通过（+1 文件 / +11 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 93.04 / 85.14 / 92.74 / 93.08；tools/read-format 91.08 / 84.43 / 97.01 / 91.01；frontend-script 92.60 / 88.07 / 94.73 / 92.53 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | exit 0（第 1 次尝试成功）：46b0054..2787be4 已推送 |

> 门禁波动取证：coverage 两次 exit 1 均由 local-preservation-restore 的 Windows 目录 rename EPERM 引起；
> 已按有界重试 + 失败即抛错（不伪造成功）修复（独立提交），修复后 coverage 稳定 exit 0。未放宽任何断言。

本检查点提交：`3b5a9dd`（rename 重试支撑修复）、`2787be4`（前端脚本策略实现）。

## 6. 未满足项与后续

- READ-FORMAT-03b：CSS/SCSS/Less、HTML 与 Vue/Svelte 混合文件区段分派（模板/脚本/样式区段）。
- READ-FORMAT-04：LaTeX、配置/文档与其他语言。
- READ-FORMAT-05：读取缓存、防重复读取、产品入口与 tarball。
- 治理文档统一修订未开始。

