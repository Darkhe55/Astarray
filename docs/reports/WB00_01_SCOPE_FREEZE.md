# WB-00-01 场景与能力边界冻结 — 证据

> 检查点：WB-00-01（docs/tasks/WB00_MICRO_EDIT_WORKBENCH_PROTOTYPE_TASK_CARD.md）
> 前驱：GUI-01-R（**未全部完成**：GUI-01-R-01~04a done，04b 待人工/打包实跑）。本卡允许"仅概念与测试方案可提前"，
> 故本轮只做概念与边界冻结，**不进入 WB-00-02 实现**。日期：2026-09-13
> 决策草案：docs/adr/0033-micro-edit-workbench-scope.md（Proposed）

## 1. 基线与并行改动

- 本轮基线提交：`229e630`（GUI-01-R-04a 记录）；工作树中用户并行文件（IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、agent-main-architecture.md、docs/tasks/README.md、tests/core/unit/application-sdk-task-events.test.ts 及 steering/WB 未跟踪文档）保持未暂存。
- **本卡文件 `docs/tasks/WB00_MICRO_EDIT_WORKBENCH_PROTOTYPE_TASK_CARD.md` 是未跟踪的用户并行文件**：按"保留用户并行改动"规则本轮不修改、不暂存；本证据文件是该检查点的权威记录。

## 2. 场景选择（专家与普通用户都可执行）

| 编号 | 场景 | 输入 | 人类动作 | 产物 |
| --- | --- | --- | --- | --- |
| S1 | 文档/说明文字小幅修订 | Markdown/纯文本 | 改错别字、措辞、补一段 | 同一产物新 revision + 不可变差异 |
| S2 | 源码小补丁 | TS/JS/JSON/YAML | 改少量字符或行 | 同上 |
| S3 | 配置/数据文本定点取值 | 配置/数据文本 | 改一个值 | 同上 |

三者都只需要"定位 + 局部替换"，不需要格式重排，因此可用零依赖实现覆盖；图片/UI、视频/音频不在本期。

## 3. 能力矩阵与往返损失（摘要，权威见 ADR-0033）

| 对象 | 原生编辑 | 局部替换 | 只读 |
| --- | --- | --- | --- |
| UTF-8 无 BOM 文本 | ✅ | ✅ | — |
| 非 UTF-8 / 二进制（含 NUL） | — | — | ✅ |
| `.env*`、私钥、凭据库、本地敏感路径 | — | — | ✅（且禁读，ADR-0018） |
| 工作区边界外 | — | — | ✅（拒绝） |
| `node_modules`/`dist`/`.git`/vendor | — | — | ✅ |
| > 256 KiB 或 > 200k 字符 | — | — | ✅ |
| 需要格式解析/重排（JSON 键排序、YAML 归一、美化） | — | — | ✅（转交任务） |

**损失边界**：不做解析-重写，只替换区间字节 → 未编辑区间字节级零损失（CRLF/LF、tab/空格、BOM、注释顺序、
JSON 键顺序均不规范化）；**明确不宣称全部格式可无损编辑**，结构化重排一律只读。

## 4. 契约映射（与现有本地约束对齐，不新造规则）

| 议题 | 现有权威 | 本期用法 |
| --- | --- | --- |
| 来源 | `contextInformationSourceSchema`（`{sourceType:"agent", agentInstanceId}` / `{sourceType:"user", userId}`） | 人类编辑必须绑定具体 `userId`；Agent 来源绑定具体 `agentInstanceId`；转发保留原始来源 |
| 变更前备份 | ADR-0009 + `BackupVault.createPreMutationBackup`（策略包装器在工具执行前调用） | 删减/覆盖前自动 pre-image 备份，不经过模型；撤销不替代备份 |
| 备份读取/恢复 | ADR-0010 受控备份工具 | 草稿与撤销都不直接读备份 |
| 敏感内容 | ADR-0018 通用禁读 | 编辑入口同样拒绝打开 |
| 并发修改 | ADR-0028 | 发布 CAS：陈旧 revision 拒绝、保留人类修改 |
| 差异预算 | ADR-0029 读预算 + 全局上下文预算（`GlobalContextBudgetStore`） | 回交模型的是有界差异，不是整份文件 |
| 草稿/发布/撤销 | 工作存档条目（`revision` 单调递增） | 草稿本地防抖保存；发布写不可变差异；撤销=再发布上一版 |
| 模式边界 | ADR-0014/0020/0021 | 思索模式完全只读；协同/放权允许本地人类编辑 |

## 5. WB-00-02 行为反例测试方案（实现轮先写这些反例）

1. **逐按键不触发模型**：输入过程中 `submitTask`/`queryTask` 调用次数为 0（含防抖窗口后）。
2. **来源具体到人类个体**：发布记录携带 `{sourceType:"user", userId}`，且缺少来源时发布被拒。
3. **删减/覆盖先备份**：删除或覆盖前后 `BackupVault` 出现 pre-image 条目，内容等于变更前字节。
4. **撤销不替代备份**：撤销后备份条目仍存在，且不能经草稿/撤销路径读取备份内容。
5. **陈旧覆盖拒绝**：以旧 `artifactRevision` 发布 → 拒绝（409 语义），人类修改保留。
6. **草稿恢复**：编辑器崩溃/重开后草稿可恢复（含 baseContentHash 与未发布正文）。
7. **只读边界**：二进制/非 UTF-8、敏感路径、工作区外、超预算文件均无编辑入口且服务端拒绝写入。
8. **有界差异**：回交模型的差异受预算裁剪；超限只给摘要与引用，不灌入整份文件。

## 6. 测试与门禁

- 本检查点为**概念/边界冻结（无产品代码变更）**：未新增或修改产品代码，故不跑 check/coverage（与 INT-00、BRIDGE-01-01、GUI-01-R-01 同类判定）。
- 累积门禁缺口已在本轮补齐并验证：`npm run check` exit 0（187 文件/1566 用例）、`npm run test:coverage` exit 0（statements 93.61% / branch 86.40% / functions 91.98% / lines 93.64%）、`verify:security-coverage` 22/22、`npm pack`+`verify-package`（207 文件）+`smoke-install` exit 0、tarball sha256 `e709427a6d52c7bbd7ebae923f5755b7ff653c67236bac886d2edea02f7e7f7e`；从隔离安装包启动 GUI 冒烟通过（`GET /` 200、`/state` 脱敏）。

## 7. 未满足项与风险

- WB-00-02 实现的前驱是 WB-00-01（已完成），但**本卡前驱 GUI-01-R 仍有 04b 未完成**（人工体验、tarball 实跑、平台证据）；按卡面"仅概念与测试方案可提前"本轮不越界实现。
- 内嵌编辑的人工体验（键盘/中文/缩放/可访问性）与本卡资源测量（WB-00-04）都需要人工结论，未测量前不宣称性能收益。
- 懒加载与零依赖编辑器是否满足编辑体验，需 WB-00-02 原型后用真实用户结论判断；必要时才走 ADR-0019 申请外部编辑器组件。

## 8. 提交与推送

- 本轮提交：`docs/adr/0033-micro-edit-workbench-scope.md` 与本证据文件（见 git 记录）。
- 推送：`git push` exit 0，`0946530..28705b2`（本轮记录提交随下一次推送补发）。
