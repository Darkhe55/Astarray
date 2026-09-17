# READ-FORMAT-02 C 系、Python、Rust 读取策略 — 证据

> 检查点：READ-FORMAT-02（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md §4，未跟踪用户文件）
> 前驱：READ-FORMAT-01（提交 `948edef`、`b814d15`，已推送）。日期：2026-09-16
> 契约：docs/adr/0042-read-format-strategy-and-receipt.md（§12 为实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/tools/read-format/read-format-scanner.ts`（新） | 语言无关扫描器：字符串/注释状态机、省略 span 补回换行保证行号恒等、`parse-error` 诚实降级、`omittedLineRanges`/`lineMap`/`limitations` 组装 |
| `packages/core/src/tools/read-format/read-format-strategies.ts`（新） | C 系（C/C++/Objective-C/C#/Java）、Python、Rust 策略 + `ReadFormatStrategyRegistry` + 回执（源哈希/revision、策略版本、filterStatus、省略范围、retainedConstructs、sensitiveCheckAppliedBeforeView、measuredUnits、budgetImpact） |
| `tests/fixtures/read-format/**`（新，8 个真实夹具） | `sample.c`/`sample.cpp`/`sample.cs`/`incomplete.c`、`sample.py`/`incomplete.py`、`sample.rs`/`incomplete.rs` |
| `tests/core/unit/read-format-strategies.test.ts`（新，12 用例） | 注册表与回执、C 系、Python、Rust 反例 |

## 2. 行为反例（真实夹具，先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 默认参数 | 原样返回、not-filtered | ✅ 五个夹具 `viewText === sourceText`、`omittedKinds=[]` |
| C 字符串里的 `//`、`/* */` | 不误删 | ✅ `"// 字符串里的斜杠不是注释"`、`"/* 字符串里的块注释标记 */"` 原样保留 |
| C 字符字面量 | 不误删 | ✅ `char character = '/';` 保留 |
| C 宏与预处理控制 | 整行保留（不删宏内注释） | ✅ `#define MAX_COUNT 42 /* 宏内的注释 */` 保留，`retainedConstructs` 含 `preprocessor-directive` |
| C++ 原始字符串 | 不误删 | ✅ `R"(// raw string 里的内容 /* 也不过滤 */)"` 保留 |
| C# 逐字/原始字符串 | 不误删 | ✅ `@"C:/path // not a comment"`、`"""raw "quoted" text // still raw"""` 保留 |
| C# `using (...)` 语句 | 不当作导入删除 | ✅ 保留，`retainedConstructs` 不含 `import-with-inline-code`，filterStatus=filtered |
| 未闭合块注释（C） | 原样 + parse-error | ✅ `isFilterable=false`、`limitations` 含 `unterminated-block-comment` |
| Python 文档字符串含 `#` | 视为语言内容保留 | ✅ `"""模块文档字符串：包含 # 井号"""` 保留 |
| Python 字符串内 `#` | 不误删 | ✅ 双引号与单引号两处均保留 |
| Python 多行 `from ... import (...)` | 整段省略 | ✅ 第 4–9 行省略，`omittedLineRanges` 命中 |
| Python 同行代码 `import os; x = 1` | 不删除并标注 | ✅ 保留，`retainedConstructs` 含 `import-with-inline-code`，filterStatus=partially-filtered |
| Python 未闭合三引号 | 原样 + parse-error | ✅ `unterminated-string-literal` |
| Rust 嵌套块注释 | 整体省略 | ✅ `嵌套内层` 不在视图 |
| Rust 文档注释 `///` | 作为注释按需省略 | ✅ 不含 `文档注释` |
| Rust 多行 `use ...::{...};` 与 `extern crate` | 整段省略 | ✅ 第 3–8 行省略 |
| Rust 原始字符串与生命周期 | 不误删 | ✅ `r#"// raw 里的斜杠不是注释"#`、`&'static str`、`let character = 'a';` 保留 |
| Rust 未闭合嵌套注释 | 原样 + parse-error | ✅ `isFilterable=false` |
| 未支持后缀 `.xyz` | 原文 + unsupported | ✅ `strategyId=unsupported`、`isFilterable=false`、`limitations` 含 `format-unsupported` |
| 行号定位 | 视图行数与源一致 | ✅ `lineMap = [{1,1,源行数}]`；省略 span 补回换行 |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/unit/read-format-strategies.test.ts --maxWorkers=4` | **0；12 passed** |
| `npx tsc --noEmit` / `npx eslint packages/core/src/tools/read-format` | 0 / 0 |

## 4. 设计边界

- 本轮**未接线 `readFile`**：产品入口（参数校验、receipt 透出、敏感检查接线、时间锁键扩展）属 **READ-FORMAT-05**；
  `readFile` 现行为不变，`builtins.test.ts` 等基线不受影响。
- 已实现能力：C 系/Python/Rust `comments=full`、`imports=full`。已知 partial（不虚报）：
  C# 超过三个引号的原始字符串、Java 文本块内含 `"""` 的极端情形、Python f-string 内部嵌套引号、
  Shell 类动态导入（不在本卡）。这些情形要么按字符串整段保留，要么触发 `parse-error` 原样返回。
- 未执行：真实项目大规模源码的吞吐/内存测量（READ-FORMAT-05 的评估项）。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` / `npx eslint .` / `npm run build` | **0 / 0 / 0** |
| `npx vitest run --maxWorkers=6` | **exit 0：215 文件 / 1731 用例全通过**（+1 文件 / +12 用例） |
| `npx vitest run --coverage --maxWorkers=6` | **exit 0**：全局 **93.05 / 85.08 / 92.71 / 93.09**；`core/src/tools/read-format` **89.68 / 81.67 / 97.78 / 89.60**；`core/src/orchestration` 93.91 / 86.64 / 94.31 / 93.95 |
| `npm run verify:security-coverage` | **exit 0：关键安全模块 22/22 达标（阈值 95%）** |
| `git push` | 见提交记录 |

> 首次 coverage 运行 exit 1（未产出摘要），重跑即 exit 0；属并行门禁波动，未放宽任何断言或阈值。

## 6. 未满足项与后续

- **READ-FORMAT-03**：前端与混合格式（模板/脚本/样式区段、JSX、URL、嵌入代码、副作用导入）。
- **READ-FORMAT-04**：LaTeX、配置/文档与其他语言（转义百分号、verbatim、Markdown 围栏、Shell heredoc、方言不支持）。
- **READ-FORMAT-05**：读取缓存、防重复读取、产品入口与 tarball（含 `readFile` 参数与 receipt 接线、补读、跨 Agent 隔离、资源测量）。
- 治理文档统一修订未开始。

