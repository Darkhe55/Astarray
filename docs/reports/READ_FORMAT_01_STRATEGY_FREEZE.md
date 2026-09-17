# READ-FORMAT-01 解析依赖核对、策略接口与能力矩阵冻结 — 证据

> 检查点：READ-FORMAT-01（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md §4，未跟踪用户文件）
> 前驱：GIT-PRESERVE-03（提交 `01c4fa0`、`333eb16`，已推送）。日期：2026-09-16
> 冻结契约：docs/adr/0042-read-format-strategy-and-receipt.md
> 基线：HEAD `333eb16` == origin/main；工作树仅有用户并行改动（未跟踪文档 + 5 个既有文件）

## 1. 审计范围与方法

只读审计，**无生产代码变更**。检索与阅读：

| 命令/文件 | 目的 |
| --- | --- |
| `grep "shouldIncludeComments|shouldIncludeImports|ReadReceipt"`（packages/core/src） | 确认两个视图参数与读取回执是否已存在（结果：**均不存在**） |
| 阅读 `tools/builtins.ts` 的 `BUILTIN_TOOL_DESCRIPTORS` 与 `executeBuiltinTool` 的 `readFile` 分支 | 现状参数、返回、门禁顺序 |
| 阅读 `tools/read-suppression-ledger.ts`（`buildReadParameterHash`、回执/拒绝结构） | 时间锁键与读取登记 |
| 阅读 `orchestration/working-set-budget-tracker.ts` 头部注释与身份计数 | 视图是否新增文件槽 |
| `grep "workingSet|readBudget"`（packages/core/src） | 读取预算接线点 |
| `package.json` 依赖表 | 是否已有语言解析依赖 |
| `grep "readFile"`（tests） | 后续 02..05 的回归基线测试 |

## 2. 现状核对（卡要求 → 现状 → 缺口）

| 卡要求 | 现状 | 结论 |
| --- | --- | --- |
| `shouldIncludeComments` / `shouldIncludeImports`（可选，默认 true） | **不存在**；`readFile` 输入只有 `filePath` | 01 已冻结接口与四种组合（ADR-0042 §2）；02 起实现 |
| 返回视图不更改源文件、不执行其代码或加载导入目标 | 现状返回原文，天然不改源文件；无过滤能力 | 冻结为硬规则（§2 规则 1） |
| 统一保留源 revision/hash、原行定位、省略类型及策略版本 | **无读取回执**：`readFile` 只返回 `outputText: string`；时间锁回执 `readReceiptId` 仅内部登记 | 01 已冻结回执字段（§4）；02 起输出结构化回执 |
| 四种参数组合 | 不存在 | 01 已冻结组合表（§2） |
| `unsupported` / `parse-error` 语义 | 不存在 | 01 已冻结（§6）：两者都返回**原文**并显式标注，不报错、不虚报 |
| 轻量策略注册表（后缀/文件名/明确格式覆盖） | 不存在；无格式识别逻辑 | 01 已冻结注册表接口与解析优先级（§3） |
| 语言感知扫描，不用通用正则跨语言删除 | 无扫描器 | 冻结为实现约束（§8） |
| 敏感检查先于返回视图 | 现状：路径禁用 + 读取前检查 + **原文**内容 DLP 后才返回；视图尚未存在 | 冻结为"对完整原文检查后才可生成视图"（§7.1） |
| 缓存键纳入文件版本、视图参数、范围、策略版本 | `buildReadParameterHash(canonicalPath)` **只哈希路径** | 01 已冻结扩展键（§7.2）；02 实现 |
| 反复切换参数不能重置总调用预算 | `WorkingSetBudgetTracker` 按**规范资源身份**计数（不同视图同一文件一个槽） | 现状可复用；冻结为"视图切换不改文件级计数"（§7.3） |
| 不同视图仍算同一个文件 | 同上 | 复用现有身份计数 |
| 文档字符串/属性/宏等语义内容不得当注释丢弃 | 无过滤，天然不丢 | 冻结为默认保留（§2 规则 2、§5） |
| 支持策略包含在 npm 包内、按需加载、不联网安装 | 无依赖；tarball 仅含 dist | 冻结依赖规则（§8） |

## 3. 四种参数组合（冻结）

| # | shouldIncludeComments | shouldIncludeImports | 行为 |
| --- | --- | --- | --- |
| 1 | true | true | 默认：原样返回（不改变现状） |
| 2 | false | true | 仅省略注释 |
| 3 | true | false | 仅省略静态导入/包含 |
| 4 | false | false | 两者都省略 |

## 4. 格式能力矩阵（冻结）

见 ADR-0042 §5：C 系、Python、Rust、前端、LaTeX、配置/文档、其他（Go/Shell/SQL）。
每个族冻结注释能力、导入范围与失败语义；无导入概念的格式返回 `imports: "unsupported"`（不适用，不是失败）。

## 5. `unsupported` / `parse-error` 语义（冻结）

- **unsupported**：不在矩阵或后缀不足 → 原文 + `isFilterable=false` + 原因；不报错、不虚报。
- **parse-error**：策略命中但扫描失败 → 原文 + 失败位置与原因；调用不失败，`isViewComplete=false`。
- **partially-filtered**：省略项与保留构造都必须列出。
- 三者都允许显式选择原文；**不修改文件**去修复解析。

## 6. 依赖核对（卡要求：新增依赖先遵守当时有效安装规则）

| 项 | 结果 |
| --- | --- |
| 生产依赖 | `commander`、`ink`、`react`、`zod`；**无任何语言解析依赖** |
| 已有解析能力 | 只有 `zod`（schema 校验）与 Node 内置；无 AST/词法库 |
| 结论 | READ-FORMAT-02..04 以**仓库内轻量策略 + 语言感知扫描**实现；如确需新增依赖，必须走**当时有效的协同模式两阶段安装门禁**（先问是否已有资源，再在独立安装开关开启时逐次绑定精确参数授权，ADR-0019），并包含在 npm 包内离线可用 |
| 禁止 | 运行时自动联网安装、隐式下载、以"读取某语言文件"为由触发安装 |

## 7. 回归基线（02..05 必须复用，不得放宽）

| 测试文件 | 覆盖 |
| --- | --- |
| `tests/core/unit/builtins.test.ts` | readFile 基本读取、路径与保护存储门禁 |
| `tests/core/unit/read-suppression-and-guard.test.ts` | 反自指时间锁、参数哈希、拒绝结构 |
| `tests/core/unit/sensitive-content-access.test.ts` | 敏感内容读取前/内容 DLP |
| `tests/core/unit/local-tool-policy.test.ts` | 读取类工具的本地策略判定 |

> 本轮为审计/冻结检查点（无生产代码变更），**未运行测试**；上述基线以静态阅读与既有测试文件为准，
> 标"未运行"。READ-FORMAT-02 开始实现时必须先跑通这些基线再改行为。

## 8. 未满足项与后续

- **READ-FORMAT-02**：C 系、Python、Rust 策略 + 真实夹具（字符串伪注释、多行导入、嵌套/逐字字符串、不完整源码、同行代码）。
- **READ-FORMAT-03**：前端与混合格式（模板/脚本/样式区段、JSX、URL、嵌入代码、副作用导入）。
- **READ-FORMAT-04**：LaTeX、配置/文档与其他语言（转义百分号、verbatim、Markdown 围栏、Shell heredoc、方言不支持）。
- **READ-FORMAT-05**：读取缓存、防重复读取、产品入口与 tarball 离线验证、资源测量。
- 治理文档统一修订未开始；本检查点未修改任何治理文档、生产代码或既有测试。

## 9. 提交与推送

- 本检查点提交：`948edef`（`docs(read-format): READ-FORMAT-01 策略接口、能力矩阵与读取回执冻结`）。
- `git push`：**exit 0**（第 1 次尝试成功，`333eb16..948edef`）。

