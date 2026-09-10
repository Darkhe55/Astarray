# T09A：全局决策提升、局部上下文节点关闭与分级回访任务卡

> 状态：`in_progress` — T09A-01/02/03 完成（契约 schema；局部上下文图存储；全局决策提升与相关选择/预算/延后片段；10+12 新测试与 70 相关套件全绿）；全量 build/spawn 门禁待审批补跑；T09A-04 待续  
> 设计日期：2026-09-09  
> 任务来源：用户  
> 优先级层级：0  
> 风险等级：高；必须按检查点单独实现和验收  
> 前驱：`T05C`、`T07A`、`T07B`、`T08A`、`T09`、`T12A`  
> 后继：`T12A/T12` 回归、`T13`、`T14`

> 架构记录：T09A-01 必须新增 ADR-0031，冻结全局/局部边界、上下文图边语义、关闭条件、人工验收策略、逻辑排除和结构化回访协议。

## 1. 目标与非目标

建立本地、版本化、可恢复的上下文生命周期控制器。历史消息不再始终整体注入模型，而被组织为：

- 跨任务稳定但不整体注入模型的全局决策库；
- 受长度硬预算和当前任务高相关性门禁控制的模型可见全局上下文；
- 按具体Agent/任务隔离、等待未来相关任务读取的延后上下文文件；
- 按具体 `agentInstanceId` 隔离的局部上下文偏序图；
- 已关闭节点的不可变关闭胶囊；
- 模型按需提出的有界结构化回访。

目标是降低长期项目的模型可见 token、旧信息干扰和重复摘要调用，同时保证关键设计理由、来源、用户验收状态及恢复能力不丢失。

本任务不删除原始会话历史，不实现语义相似模型结果缓存，不放宽任何工具权限、敏感禁读或工作集预算，也不允许 Agent 自行把输出声明为用户已验收。

## 2. 冻结领域模型

### 2.1 全局决策记录

定义 `GLOBAL_DECISION_RECORD_V1`，至少包含：

- `globalDecisionIdentifier`、`schemaVersion`、`globalContextRevision`；
- 决策结论、关键理由、被否决方案及原因；
- 适用范围、关联任务/上下文节点、产物和提交引用；
- 原始来源：认证用户或具体且不可复用的 `agentInstanceId`；
- 来源 revision、内容哈希、创建时间；
- `active | pending-human-review | disputed | stale | superseded`；
- 失效条件和可选 `supersedesGlobalDecisionIdentifier`。

模型只能提交提升候选。本地控制器负责 schema、来源、去重、冲突、范围、revision 和哈希校验。临时日志、源码正文和长工具输出不得直接提升。全局记录不得覆盖更新；状态变化和替代关系使用追加事件。

全局决策库不等于当前模型可见的全局上下文。定义公开的 `GlobalContextBudgetPolicy` 设置：`maximumGlobalContextTokenCount` 初始默认4096；认证用户可从TUI、Headless CLI和GUI共用设置控制器调高、调低或设为0，0表示保留决策库但关闭自动注入。字段只接受非负整数，使用单调 `globalContextBudgetPolicyRevision`；Agent、模型、项目文字和普通导入不能修改。设置变化从下一次prompt装配生效，不取消在途Provider请求，也不改写决策库或延后文件。

本轮实际上限取用户设置值与当前Provider/模型剩余可用输入token的较小值，并预先扣除系统规则、当前任务、工具说明、必要局部证据和预期输出保留量。界面和JSON状态必须同时返回 `configuredMaximumGlobalContextTokenCount`、`effectiveMaximumGlobalContextTokenCount` 和缩减原因。上下文装配器始终执行实际硬上限。单条记录不能通过字符串截断塞入预算；超限时选择更小的完整摘要或要求拆分任务。

定义本地 `GlobalContextRelevanceSelector`。只有记录与当前任务存在版本化的直接任务依赖、前驱关系、作用域、接口、产物/提交、路径范围或用户固定关联之一，并通过冲突与失效检查时，才可进入候选集合。模型语义评分只能辅助排序，不能单独满足“高度相关”。稳定选择顺序为当前任务直接约束、必要前驱决策、当前接口/产物契约、当前范围用户偏好；同级按稳定序号排序。

未选内容和超预算详情写入 `GLOBAL_CONTEXT_DEFERRED_FRAGMENT_V1`，规范位置为 `.astarray/agent-memory/<agentInstanceId>/deferred-context/<fragmentIdentifier>.json`，至少记录所有者Agent、任务/mission、来源节点/revision、内容哈希、主题与显式关联键、估算token、失效条件和创建时间。文件位于所有者个体记忆域，不进入普通prompt、稳定缓存前缀或其他Agent上下文；后续相关任务命中显式关系或发出结构化请求后受控读取。它是持久化的延后上下文文件而非可无审计清理的系统临时文件，默认保留至来源任务和引用任务均归档；清理、覆盖或删除仍走自动备份。

### 2.2 局部上下文偏序图

定义独立于任务偏序集的 `LOCAL_CONTEXT_GRAPH_V1`。节点至少绑定所有者 `agentInstanceId`、任务/mission、图 revision、消息范围、状态、来源摘要和内容指纹。

边类型：

- `required`：参与关闭闭包；
- `optional`：不阻塞关闭；
- `reference`：只表达引用；
- `supersedes`：表达替代；
- `waived`：由认证用户明确豁免的必要分支。

图必须拒绝环、未知锚点、跨 Agent 直接所有权和陈旧 revision。局部上下文图可引用任务节点，但不得复用任务 `done` 作为上下文关闭状态。

### 2.3 关闭状态

状态至少包括：

```text
active
completion-claimed
locally-verified
awaiting-user-acceptance
accepted-closed
deferred-review-closed
reopened
superseded
```

关闭必要条件：节点自身本地验收通过；所有 `required` 直接子节点均为可接受关闭状态或有有效用户豁免；无未决工具、权限、反馈、Git、失败或取消；全局决策提升完成；写入基于当前 expected revision。

叶节点仍须满足自身门禁。为每个节点持久化 `openRequiredChildCount` 并增量传播；任何新增必要分支、来源产物变化、验收失效或人工否决都递增图 revision 并重新开放受影响节点。

## 3. 人工验收设置与延迟核验

新增公开设置：

```ts
type HumanVerificationContinuationPolicy =
  | "block-until-verified"
  | "continue-with-deferred-review";
```

- Assist 默认 `block-until-verified`，认证用户可通过独立设置开关改为延迟核验。
- Devolve 默认 `continue-with-deferred-review`，用户可改为阻塞验收。
- 自定义模式保存自己的明确默认值。
- Ponder 不产生写入型任务或关闭事件，不提供运行时切换。
- 设置 revision 变化只影响尚未执行的状态迁移；不能伪造过去的用户签字。
- 本设置只控制普通人工验收的任务推进，不修改安装、备份删除、发布、权限或其他专用门禁。

阻塞策略把人工验收节点作为后续依赖的必要前驱。单次 `pn` 等待最长3小时；超时保持等待，不自动通过，且等待期间不得持有文件锁、任务锁、Provider请求或Git工作树锁。

延迟策略必须先原子写入 `DEFERRED_HUMAN_VERIFICATION_TASK_V1`，才能把节点变为 `deferred-review-closed`。补充任务由本地控制面产生，只能使用优先级层级 1 或以下，并包含原节点/revision、关闭胶囊哈希、产物/提交、测试、风险、人工步骤和通过/否决动作。该状态在任何用户界面、报告和模型上下文中都不得表述为“用户已验收”。

事后验收否决时，控制器重新开放节点、标记相关全局决策为 `disputed`/`stale`、失效相关缓存、标记受影响下游并创建返修任务。不得自动删除、覆盖、回滚、变基、发布或改写 Git 历史。

## 4. 关闭胶囊与结构化回访

每个关闭节点生成 `CONTEXT_CLOSURE_CAPSULE_V1`：

- 节点、任务、Agent 和图 revision；
- 最终决定及已提升的全局决策引用；
- 输入/输出摘要；
- 自动验收和人工验收状态；
- 产物、Git提交和测试证据；
- 来源、内容哈希、未决项和重新开放条件。

关闭只是从普通提示词逻辑排除完整局部历史，原文继续留在所有者个体存档。任何物理压缩、覆盖或删除继续执行工具内自动备份。

定义模型可见的只读回访请求 `ASTARRAY_CONTEXT_RECALL_REQUEST_V1`，字段至少包括请求 ID、任务执行 ID、关闭节点 ID/revision、原因码、所需信息和最大 token 数；`agentInstanceId` 由 harness 注入。返回顺序固定为：

```text
节点索引 → 关闭胶囊 → 选定证据 → 有界完整局部片段
```

无范围的完整历史请求必须拒绝。重复读取未变化节点复用现有读取回执和冷却；跨 Agent 只能使用显式选择的不可变附件。回访不能绕过敏感禁读、权限、反自指/活锁、任务累计调用预算、token预算和默认10文件工作集。

## 5. 缓存和提示词装配

重构现有单体 `contextSummaryHash` 使用方式，但保持旧缓存兼容迁移：

1. 全局决策分块缓存：安全/权限、架构、用户偏好、接口契约、项目状态分别哈希。
2. 活跃前沿缓存：只包含当前活跃节点、必要开放祖先和图 revision。
3. 关闭胶囊缓存：按节点 ID、关闭 revision、胶囊哈希和产物指纹。
4. 回访结果缓存：按具体 Agent、任务、节点/revision、原因码、选择策略和token预算。

全局缓存键还必须包含全局预算策略revision、当前任务关系集合哈希和选择结果哈希。延后文件只有在被当前任务选中时才进入本轮局部证据缓存，不能因文件存在而污染全局稳定前缀。

提示词稳定顺序为系统/安全规则、全局块、Agent身份与工具、活跃前沿、必要证据、本轮输入。时间戳、随机请求 ID 和运行序号不得污染可缓存前缀。

只缓存确定且无副作用的上下文装配、闭包计算和摘要；写操作、授权、时间敏感结果、失败结果和任务执行结论继续 bypass。节点重开、图/profile/tool/model/Provider revision、产物指纹或全局块变化必须精确失效相关缓存，不得静默复用陈旧结果。

## 6. 指标与优化判定

扩展指标注册表，至少计算并按模式、Provider、模型、任务类型和 Agent用途分组：

- 原始缓存命中率：`hit / (hit + miss)`；
- 可复用 token 比率：成功复用 token / 符合复用条件 token；
- 关闭上下文 token 节省率：被排除的关闭节点 token / 候选历史 token；
- 关闭节点回访率：被回访的唯一关闭节点 / 被排除的唯一关闭节点；
- 重复回访率：同 Agent 对同一未变化 revision 的重复请求 / 全部回访请求；
- 有效回访率：产生新证据、解决阻塞或触发合法重开的回访 / 全部回访；
- 过早关闭率：因摘要或闭包错误重开的节点 / 全部关闭节点；
- 全局提升使用率及无效提升率；
- 当前全局上下文token数量和预算利用率；
- 全局预算淘汰率；
- 延后上下文片段后续命中率；
- 被注入但与任务无显式关系的错误相关内容计数；
- 延迟验收否决率；
- 否决后的下游影响节点数量、返工 token 和返工时间。

原因码必须区分用户新需求、依赖真实变化、人工否决、全局决策缺失、胶囊不足和模型重复请求。不得把用户新需求导致的合法重开统计为过早关闭。

首个检查点只建立基线，不承诺无数据的绝对收益。完整实现的初始观察门槛为：相对基线平均提示词 token 降低至少25%；同一未变化 revision 重复回访率不高于5%；过早关闭率不高于1%；未达到时不得仅通过减少测试样本或拒绝合法回访宣称通过。

## 7. 检查点序列

| 检查点 | 内容 | 主要验收 |
|---|---|---|
| T09A-01 | ADR-0031、全局记录/可调预算/延后片段/上下文图/关闭/回访/设置 schema | schema、迁移、来源、revision、预算设置、环和陈旧签字反例 |
| T09A-02 | 上下文图存储、闭包计数和增量重新开放 | DAG、叶节点、required/optional、并发CAS、故障注入 |
| T09A-03 | 全局决策提升、相关选择、长度预算、延后文件、去重/冲突/失效 | 只注入高相关最小内容；超限不截断；无关内容延后；替代不覆盖历史 |
| T09A-04 | Assist阻塞验收、Devolve延迟核验及设置开关 | 两模式默认值、切换、3小时上限、补充任务层级、否决返修 |
| T09A-05 | 关闭胶囊、提示词活跃前沿和分级回访 | 关闭历史不注入；按级恢复；个体隔离；敏感/预算/循环反例 |
| T09A-06 | 分层缓存、精确失效、指标和自适应诊断 | token复用、重复回访、过早关闭、否决扩散指标可复算 |
| T09A-07 | TUI/CLI/GUI共用状态适配器和用户文案 | 显示已验收/待追认、配置/实际token上限；设置可改；不泄露其他Agent上下文 |
| T09A-08 | T12A/T12恢复安全回归、压力测试与tarball验收 | 重启重放、半写入、并发、新分支重开、npm隔离安装全绿 |

每轮只执行一个检查点，每个检查点预计不超过3小时；超过时继续拆分，不得压缩测试或合并检查点规避时限。

## 8. 必测场景

1. 叶节点没有出分支但自身未验收时不能关闭。
2. 必要分支未完成时父节点不关闭；可选/引用分支不阻塞；有效豁免绑定用户和revision。
3. 节点关闭后新增必要分支，节点及受影响祖先重新开放，旧签字不复用。
4. 任务 `done` 但人工或Git门禁未满足时，上下文仍不能正式关闭。
5. 关键理由提升后局部原文退出提示词，后续任务仍能从全局记录获得决定和来源。
6. 全局决策库超过4096估算token时，当前任务prompt仍不超预算；选择结果只含有显式高相关关系的完整最小记录。
7. 用户把上限调高、调低和设为0后，下一轮分别采用新revision；Provider空间不足时实际上限正确缩减并保留原因，在途请求不被取消。
8. 无关记录和超预算详情写入正确Agent/任务的延后文件，不进入普通prompt或其他Agent缓存；相关任务到来后可按revision读取。
9. 待追认节点的全局记录保持 `pending-human-review`，不能被报告为用户确认。
10. Assist默认阻塞；开关改变后创建补充核验任务再继续。Devolve默认非阻塞，也可切换为阻塞。
11. 延迟核验任务来源和优先级正确，Agent/system/tool不能伪造用户层级0。
12. 事后否决使节点、缓存和全局决定失效，创建返修但不自动执行破坏性回滚。
13. 相同关闭节点的重复请求返回回执；内容或revision真实变化后允许重新读取。
14. 索引、胶囊或证据足够时不返回完整历史；完整片段受token和任务预算约束。
15. 两个同级Agent使用相同节点显示名时，存档、缓存、延后文件和回访结果仍完全隔离。
16. `.env`、凭据、私钥和DLP命中内容不能经全局提升、延后文件、胶囊、缓存或回访旁路进入模型。
17. 崩溃发生在签字、胶囊、延迟任务、关闭标记或父计数写入之间时，恢复结果一致且不重复副作用。
18. 全局单块变化只失效相关块；活跃局部变化不使全部稳定前缀失效。
19. 指标能区分用户新需求重开和错误关闭，能从原始事件重新计算。
20. 从npm tarball隔离安装后，TUI和Headless均能查看状态、修改允许的设置并执行确定性演示闭环。

## 9. 执行注意事项

- 本任务属于高风险状态机、缓存和恢复交叉修改，不能与Provider、GUI、T12综合安全或最终打包合批。
- 每轮默认只完成一个检查点，同时交付实现、测试、文档和 `PLAN_STATUS.md` 动态证据；前一检查点不通过不得领取后继。
- 一个检查点建议修改5–15个生产文件；预计超过约1,000行生产代码或3小时即继续拆卡。
- 生产变量/函数名必须完整可读；布尔量使用 `is/has/can/should`，时间量带单位，数量带 `Count`，token量带 `TokenCount`，revision名称不得缩写。
- 先写失败测试和schema，再实现控制器。不得用模型自述、mock通过或任务卡静态状态代替动态验收。
- 所有持久化写入使用expected revision、原子替换和可恢复日志；等待人工时不得持锁。
- 上下文关闭不允许删除原文。任何后续物理压缩、删减或覆盖由执行工具自动备份。
- 指标优化不能以拒绝合法回访、隐藏失败、减少样本、缩短历史或合并Agent记忆取得。
- T09A完成后必须重新运行T12A/T12相关故障注入、安全反例和跨进程恢复测试。

## 10. 每个检查点的验收命令

至少执行：

```powershell
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run build
npm run check
```

T09A-07和T09A-08另需执行PTY/TUI、Headless JSON契约、跨平台目标矩阵，以及：

```powershell
npm pack
node scripts/verify-package.mjs
node scripts/smoke-install.mjs
```

必须记录实际退出码、测试数量、覆盖率、tarball文件列表和隔离安装结果。不得只记录“通过”。

## 11. 完成事件

```text
ASTARRAY_TASK_COMPLETION_V1
taskCardId: T09A-XX
agentInstanceId: <具体且不可复用的Agent个体ID>
sourceKind: user
priorityTier: 0
contextGraphRevisionBefore: <revision>
contextGraphRevisionAfter: <revision>
closedContextNodeCount: <数量>
deferredHumanVerificationTaskCount: <数量>
reusableTokenRatio: <比例或baseline-only>
globalContextTokenCount: <数量>
configuredMaximumGlobalContextTokenCount: <数量>
effectiveMaximumGlobalContextTokenCount: <数量>
deferredGlobalContextFragmentCount: <数量>
closedContextRecallRate: <比例或baseline-only>
unchangedRevisionRepeatRecallRate: <比例或baseline-only>
prematureClosureRate: <比例或baseline-only>
executedChecks:
  - command: <命令>
    exitCode: <退出码>
recoveryAndBypassEvidence:
  - <闭包、跨Agent、敏感内容、缓存失效、崩溃恢复反例>
remainingRisks:
  - <没有则写none>
completionGate: passed | failed | blocked
```

出现过早关闭、签字跨revision复用、待追认冒充已验收、关闭导致历史删除、回访绕过敏感策略、跨Agent记忆泄漏或恢复后重复副作用时，不得标记完成。

## 12. 可直接交给OpenCode的首轮指令

```text
完整读取AGENTS.md规定的四份根目录文档、ADR-0005、ADR-0013、
ADR-0015、ADR-0017、ADR-0022、ADR-0023、ADR-0029、ADR-0030和
T09A任务卡。先动态核对T05C、T07A、T07B、T08A、T09、T12A前驱；
前驱不满足时只报告阻塞。本轮仅执行T09A-01：先建立ADR-0031与
全局决策、局部上下文图、关闭状态、人工验收策略和回访请求schema的
失败测试，再实现契约。不得提前接入提示词、缓存、界面或恢复流程。
```
