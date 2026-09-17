# ADR-0042 内置多格式读取视图（策略注册表、能力矩阵与回执契约）

- 状态：已采纳（READ-FORMAT-01 冻结；实现属 READ-FORMAT-02..05）
- 日期：2026-09-16
- 来源：docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md §4（用户指导，未跟踪文件）
- 相关：ADR-0018（敏感内容禁读）、ADR-0029（工作集与读取预算）、ADR-0017（反自指/活锁）、ADR-0019（安装两阶段门禁）、既有 readFile 内置工具与 ReadSuppressionLedger

## 1. 背景与现状

- readFile 目前参数只有 filePath，返回**原文**字符串；没有视图参数、没有读取回执。
- buildReadParameterHash(canonicalPath) 只哈希路径；视图参数变化尚不影响时间锁键。
- WorkingSetBudgetTracker 已按**规范资源身份**计数：不同视图仍是同一个文件，只占一个槽。
- 仓库依赖只有 commander/ink/react/zod：**没有任何语言解析依赖**。
- 敏感内容门禁在 readFile 中于**读取前与内容 DLP** 两处执行（ADR-0018）。

本 ADR 冻结 shouldIncludeComments/shouldIncludeImports 两个参数、四种组合、策略注册表接口、
格式能力矩阵，以及 unsupported/parse-error 语义与读取回执契约。

## 2. 参数与四种组合（冻结）

readFile 新增两个**可选**参数，默认 true（默认行为与现状一致）：

| # | shouldIncludeComments | shouldIncludeImports | 行为 |
| --- | --- | --- | --- |
| 1 | true | true | **默认**：原样返回（不做任何过滤） |
| 2 | false | true | 仅省略注释；导入/包含保留 |
| 3 | true | false | 仅省略静态导入/包含；注释保留 |
| 4 | false | false | 注释与静态导入/包含都省略 |

规则：

1. 视图**不修改源文件**、**不执行其代码**、**不加载/解析导入目标**；只做文本级呈现变换。
2. 省略类型必须可枚举：comment、import-statement、include-directive；有语义内容（Python 文档字符串、
   Rust 属性、C 宏、LaTeX 逐字环境）**默认保留**，不得当普通注释删除。
3. 回执保留**原始行号定位**：返回内容标注源文件起止行；省略处给出被省略的行区间与类型。
4. 反复切换参数**不重置总读取调用预算**；视图参数只影响单次返回内容与缓存键，不改变文件级工作集计数。
5. 允许显式返回原文：参数缺省（组合 1）即原文；显式传 false 才过滤。

## 3. 策略注册表接口（冻结）

~~~
interface ReadFormatStrategy {
  strategyId: string;                 // 稳定 ID，进入策略版本
  policyVersion: number;              // 能力/语义版本；缓存键与回执都必须记录
  match(input: { fileName: string; extension: string; contentSample: string }):
    { isMatch: boolean; specificity: number };   // specificity 越高越优先
  capabilities: {
    comments: "full" | "partial" | "unsupported";
    imports: "full" | "partial" | "unsupported";
    commentSyntaxFamily: string | null;
  };
  buildView(input: { sourceText: string; shouldIncludeComments: boolean; shouldIncludeImports: boolean }):
    ReadViewBuildResult;
}
~~~

解析顺序：**显式按格式覆盖 > 特定文件名（Makefile/Dockerfile/…）> 后缀 > 内容采样提示 > 未知（unsupported）**。
后缀不足以确定方言时按 partial 如实处理（例如 .h 无法区分 C/C++ 时不得编造）。

## 4. 视图回执（冻结）

readFile 返回结构化回执（正文 + 元数据），至少含：

~~~
{
  filePath, resolvedPathCategory,          // 不回传内部物理路径细节
  sourceRevisionKind: "git-oid" | "content-hash" | "mtime+size",
  sourceRevision, sourceHash,              // 统一保留源 revision/hash
  policyVersion, strategyId,
  viewParameters: { shouldIncludeComments, shouldIncludeImports },
  filterStatus: "not-filtered" | "filtered" | "partially-filtered"
              | "unsupported" | "parse-error",
  omittedKinds: string[],
  omittedLineRanges: Array<{ kind: string; startLine: number; endLine: number }>,
  retainedConstructs: string[],            // 无法安全判定而保留的构造 + 原因
  lineMap: Array<{ returnedStartLine: number; sourceStartLine: number; lineCount: number }>,
  isViewComplete: boolean,                 // false ⇒ 改动前应按需补读原文
  isFilterable: boolean,                   // unsupported/parse-error ⇒ false
  limitations: string[],
  sensitiveCheckAppliedBeforeView: true,
  measuredUnits: number,                   // 视图计量（token/字节）
  budgetImpact: "same-file"                // 视图不新增文件槽
}
~~~

## 5. 格式能力矩阵（冻结范围）

| 格式族 | 后缀/文件名 | 注释能力 | 导入/包含范围 | 失败语义 |
| --- | --- | --- | --- | --- |
| C 系 | c/h/cpp/hpp/cc/m/mm/cs/java | full（块+行注释）；**宏与预处理控制保留** | #include、import、普通 using；不解析宏展开 | 不完整源码 → parse-error 或 partial，保留 |
| Python | py/pyi | full；**文档字符串视为语言内容，默认保留** | import x、from x import；不执行 | 缩进/语法不完整 → partial |
| Rust | rs | full（含嵌套块注释）；属性/宏/字符串保留 | use、extern crate | 嵌套注释不完整 → parse-error |
| 前端 | js/jsx/ts/tsx/mjs/cjs/vue/svelte/html/css/scss/less | full/partial（按区段） | ESM import、export ... from、require、@import；**动态导入保留并标记** | 混合文件按区段分派，区段失败不影响其他区段 |
| LaTeX | tex/sty/cls | 百分号注释；**转义百分号与 verbatim 环境必须正确** | \usepackage/\input/\include（静态） | 不执行宏；无法判定 → partial |
| 配置/文档 | json/jsonc/yaml/yml/toml/md/markdown/txt | 各语言合法注释；Markdown 围栏内不解析 | 无导入概念 → imports: unsupported（返回不适用，不是失败） | JSON 非法 → parse-error（返回原文） |
| 其他 | go/sh/sql | full/partial（方言） | Go import、Shell source/点命令（**动态脚本不冒充静态导入**）、SQL 方言限制 | 方言不支持 → partial/unsupported 并标注 |

## 6. unsupported / parse-error / partially-filtered 语义（冻结）

- **unsupported**：格式不在矩阵内（或后缀不足以确定）→ 返回**原文**，isFilterable=false、
  filterStatus="unsupported"、limitations 说明原因；**不报错、不虚报已过滤**。
- **parse-error**：策略命中但扫描失败/构造不完整 → 返回**原文**，filterStatus="parse-error"，
  附失败位置与原因；调用不失败，但 isViewComplete=false。
- **partially-filtered**：能安全过滤一部分 → filterStatus="partially-filtered"，
  omittedKinds + retainedConstructs 都必须列出。
- 三者都**允许用户显式选择原文**（组合 1）；**不修改文件**去修复解析。

## 7. 安全、缓存与预算接线（冻结）

1. **敏感检查先于视图**：对**完整原文**执行路径禁用 + 内容 DLP，任何参数都不能让视图绕过；
   被拒绝时不得返回任何视图，也不得登记内容指纹。
2. **反自指时间锁**：buildReadParameterHash 扩展为
   (canonicalPath, normalizedRange, shouldIncludeComments, shouldIncludeImports, policyVersion)；
   同一视图重复读取仍 resource-already-read；不同视图属于不同键，但**源内容指纹不变**时不得借切换参数刷新窗口。
3. **工作集预算**：沿用 WorkingSetBudgetTracker 的**规范资源身份**——不同视图仍是同一文件，只占一个槽；
   切换参数不重置总调用预算；补读被省略区段是合法读取，按同一文件计数并正常消耗单次调用预算。
4. **缓存键**：文件版本 + 视图参数 + 范围 + policyVersion；策略升级后旧视图缓存失效。

## 8. 依赖规则（冻结）

- 现状：无任何语言解析依赖。READ-FORMAT-02..04 以**仓库内轻量策略/语言感知扫描**实现，
  不引入通用正则跨语言删除内容。
- 若确需新增依赖：必须走**当时有效的安装规则**（协同模式两阶段门禁：先询问是否已有可用资源，
  再在独立安装开关开启时逐次绑定精确内容与参数授权，ADR-0019），且必须包含在 npm 包内、
  离线可用（tarball 隔离验证），**不得**运行时自动联网安装或隐式下载。
- 评估项：包体积、解析耗时、峰值内存、模型返回量；**不承诺必然减少磁盘 I/O**。

## 9. 非目标

- 不做代码执行、导入解析/求值、类型检查或写回；过滤结果**不是可直接覆盖写回的完整源码**。
- 不因本功能放宽敏感内容、保护存储、安装或 Git 授权规则。
- 不要求所有格式首轮就 full；partial/unsupported 是合法且必须诚实标注的结果。

## 10. 检查点映射

- **READ-FORMAT-01**（本 ADR）：核对已有解析依赖；冻结策略接口、格式能力矩阵与公共回执。无生产代码变更。
- **READ-FORMAT-02**：C 系、Python、Rust 策略 + 真实夹具（字符串伪注释、多行导入、嵌套/逐字字符串、不完整源码、同行代码）。
- **READ-FORMAT-03**：前端及混合格式策略（模板/脚本/样式区段、JSX、URL、嵌入代码、副作用导入）。
- **READ-FORMAT-04**：LaTeX、配置/文档与其他语言（转义百分号、verbatim、Markdown 围栏、Shell heredoc、方言不支持）。
- **READ-FORMAT-05**：读取缓存、防重复读取、产品入口与 tarball（补读、跨 Agent 隔离、未支持格式不虚报、离线可用与资源测量）。

## 11. 风险

- 过滤可能让模型误以为看到了完整源码 → 强制 isViewComplete/limitations + 改动前补读提示。
- 语言感知扫描复杂度高 → 按族拆分检查点、先支持 full，其余如实 partial/unsupported。
- 视图参数进入时间锁键可能被滥用刷新窗口 → 以**源内容指纹**为准，视图切换不算内容变化。

## 12. 实现记录（READ-FORMAT-02）

- 模块：`packages/core/src/tools/read-format/read-format-scanner.ts`（扫描器）+
  `read-format-strategies.ts`（策略/注册表/回执）。
- 行号对齐：省略 span 时补回其内部换行，视图行数与源文件一致 → `lineMap` 恒等
  `[{1,1,总行数}]`；`omittedLineRanges` 给出被省略的行区间与类型（含跨行块注释/多行导入）。
- 注释过滤豁免：C 系预处理指令整行保留（`isCommentFilterExemptLine`），行内含注释标记时记
  `retainedConstructs=["preprocessor-directive"]`，必要时降级 `partially-filtered`。
- 诚实降级：未闭合字符串/块注释 → `parse-error` 且返回原文；未匹配格式 → `unsupported`；
  同行的 import+代码 → 保留并记 `import-with-inline-code`（`partially-filtered`）。
- `readFile` 参数与 receipt 透出、敏感检查接线、时间锁键扩展属 **READ-FORMAT-05**；本轮不改 `readFile`。
- 真实夹具：`tests/fixtures/read-format/**`（C/C++/C#/Python/Rust 的注释、字符串、导入、不完整源码）。

## 13. 实现记录（READ-FORMAT-03a）

- 模块：`packages/core/src/tools/read-format/read-format-frontend-script.ts`；策略 ID `frontend-script`，
  覆盖 `.js/.jsx/.ts/.tsx/.mjs/.cjs`（`.jsx/.tsx` 启用 JSX 模式）。
- JSX 模式：文本区中的 `//` 与 `/*` 视为文本；`{…}` 进入表达式容器后才按代码处理注释；
  标签属性中的字符串与表达式、自闭合与闭合标签均回落正确状态。
- 正则/除法：依据前一个有效记号与关键字（return/typeof/…）判定；无法判定时按除法保留。
- 动态 `import()`：保留并记 `dynamic-import`；静态 import/export-from/require 按需省略；
  同行代码时保留并记 `import-with-inline-code`。
- 状态规则：仅在确有省略时为 `filtered`/`partially-filtered`；仅保留构造而无省略时状态为
  `not-filtered`，并通过 `retainedConstructs`/`limitations` 如实说明（不虚报已过滤）。
- CSS/HTML/Vue/Svelte 区段分派属 **READ-FORMAT-03b**。

## 15. 实现记录（READ-FORMAT-04a）

- 模块：`read-format-latex.ts`（转义 \%、逐字环境、usepackage/input/include）与
  `read-format-config-documents.ts`（JSON/JSONC、YAML、TOML、Markdown、纯文本）。
- 扫描器新增 `shouldTreatAsLineComment` 钩子（YAML 的 `#` 仅在行首或空白后成立）。
- 无导入概念的格式（JSON/JSONC/YAML/TOML/Markdown/纯文本）在 `shouldIncludeImports=false` 时追加
  `imports-unsupported` 说明；JSON/纯文本在 `shouldIncludeComments=false` 时追加 `comments-unsupported`。
- Markdown 围栏代码块按行整体保留，注释仅过滤 `<!-- -->`；未闭合注释 → parse-error。
- Go/Shell/SQL 属 **READ-FORMAT-04b**。

## 14. 实现记录（READ-FORMAT-03b）

- 模块：`read-format-frontend-styles.ts`（CSS/SCSS/Less，含 `url(...)` 片段保护）与
  `read-format-frontend-markup.ts`（HTML 注释/静态资源标签 + 顶层区段分派）。
- 策略 ID：`style-sheet`（.css/.scss/.less/.sass）、`html`、`vue`、`svelte`。
- 区段分派：`<template>` → markup；`<script>` → 脚本策略；`<style>` → 样式策略（按 lang 选择行注释）；
  子视图省略区间按区段起始行偏移，视图总行数不变（lineMap 恒等）。
- 带 `src` 的 `script`/`style` 视为资源引用标签（由静态资源标签规则处理），不作为承载代码的区段。
- 任一子视图 parse-error → 整个视图 parse-error 并返回原文。

