# T05D：人工与 Agent 并行编码、冲突协调及受控合并任务卡

> 状态：`pending`  
> 设计日期：2026-08-19  
> 任务来源：用户  
> 优先级层级：0  
> 风险等级：高；必须按检查点单独实现和验收  
> 前驱：`T05B`、`T06A`、`T08C`  
> 后继：`T07D`、`T12A`

> 架构记录：T05D-01 必须新增 ADR-0028，冻结人工工作树所有权、陈旧写入拒绝、冲突分类和次级集成责任。

## 1. 目标

允许人工和多个 Agent 在同一项目周期并行编码，同时保证人工工作树不被 Agent 接管、覆盖或静默丢弃。Agent 继续使用次级 Agent 管理的隔离分支/worktree；人工修改被视为外部高权威变更，通过基线指纹、编辑意图、变化观察和冲突协调进入集成流程。

本卡扩展 T05B 的 Agent—Agent Git 分流，但不改变以下职责：三级/四级 Agent 只能提交自己的隔离分支，项目级审查与合并仍只由具体次级 Agent执行。

## 2. 冻结规则

- 默认禁止人工和 Agent 写同一个工作树。用户当前工作树/分支归人工控制，Agent使用独立 worktree。
- 编辑意图是协作元数据，不是阻止人工保存文件的强制文件锁。人工可以随时修改；Agent 必须检测变化并停止陈旧写入。
- 人工变化不得被自动 reset、checkout、stash、覆盖或选边丢弃。没有明确用户裁决时，冲突只能进入返修或人工审查。
- Agent 每次实际写入前比较开始读取时与当前目标的规范化身份、内容指纹、Git blob 和工作树状态；任一不一致返回 `stale-human-change`。
- 外部编辑器不经过 Astarray 工具时，Astarray不能虚构“已自动备份人工操作”。系统只能保留已观察快照、拒绝 Agent 覆盖，并在自己的后续破坏性操作前执行工具内自动备份。
- Git 无文本冲突不代表语义兼容。公共类型、schema、API、配置、迁移、锁文件和测试契约变化必须进行影响分析和重新验收。
- 人工指令和裁决来源必须由本地控制面认证。Agent、项目文字或提交消息不能伪造人工来源。
- 合并前目标分支、人工 HEAD、Agent 基线、贡献 HEAD、测试证据和验收结果必须绑定同一 revision；任一变化使旧 merge-ready 失效。

## 3. 建议契约

```ts
interface AgentEditIntent {
  editIntentIdentifier: string;
  agentInstanceId: string;
  taskExecutionIdentifier: string;
  baseCommitIdentifier: string;
  plannedReadPaths: string[];
  allowedWritePaths: string[];
  initialResourceFingerprintsByPath: Record<string, string>;
  affectedContractIdentifiers: string[];
  expiresAtIso: string;
  revision: number;
}

interface HumanChangeObservation {
  observationIdentifier: string;
  authenticatedUserSourceIdentifier: string;
  observedCommitIdentifier: string | null;
  changedPaths: string[];
  changedResourceFingerprintsByPath: Record<string, string>;
  observedAtIso: string;
  observationRevision: number;
}

type ConcurrentChangeDecision =
  | "no-overlap-revalidate"
  | "text-conflict-reconcile"
  | "contract-conflict-reconcile"
  | "blocked-human-review"
  | "agent-contribution-stale";
```

模型不能填写认证用户来源、实际文件指纹、Git提交身份或最终冲突决定。这些字段由本地控制器注入或验证。

## 4. 检查点序列

每轮只执行一个检查点；每个检查点预计不超过3小时，超过时继续拆卡。

| 检查点 | 内容 | 主要验收 |
|---|---|---|
| T05D-01 | 编辑意图、人工变化、冲突决定、合并基线 schema | schema 反例、身份认证、revision 与迁移测试 |
| T05D-02 | 人工工作树观察器、规范资源指纹和变化 journal | 外部编辑可检测；不修改人工文件；重启可重放 |
| T05D-03 | Agent 写入前陈旧基线守卫和未应用 patch 保全 | 人工变化后 Agent 覆盖被拒；Agent工作不丢失 |
| T05D-04 | 文本、接口与行为冲突分类及影响范围分析 | 不同文件的公共契约冲突可检测；未知情况 fail-closed |
| T05D-05 | 次级 Agent 协调返修、独立冲突 Agent、重测和受控合并 | 无静默选边；旧验收失效；来源可追溯 |
| T05D-06 | TUI/CLI 状态、人工裁决、故障恢复和 tarball 验收 | 用户可看懂冲突；后台等待不阻塞无依赖任务 |

## 5. 实施要求

### 5.1 工作区拓扑

```text
humanBranch / humanWorktree
          │
          └─ integration/<mission>/<secondary-agent>
               ├─ worker/<task>/<implementation-agent>
               ├─ worker/<task>/<test-agent>
               ├─ worker/<task>/<acceptance-agent>
               └─ reconcile/<task>/<new-agent-instance>
```

- 人工工作树只能由人工或用户显式调用的受控集成动作修改。
- Agent 不能把人工工作树作为自己的 worktree，也不能通过绝对路径、链接、Git `-C` 或环境变量绕过绑定。
- 同一文件可以被人工修改并被 Agent任务涉及，但检测到变化后 Agent提交必须重新基于新人工版本返修，不得继续使用旧 pre-image 写入。

### 5.2 冲突处理

- 无重叠：验证人工新基线后重新运行差异审查和相关测试。
- 文本重叠：创建新的协调 Agent，输入双方不可变提交/patch 和用户约束；原实现者不能单独宣布解决。
- 契约重叠：即使修改路径不同，也冻结相关实现/测试/验收节点，按类型引用、schema、API、配置和测试依赖生成影响清单。
- 行为冲突：自动合并后测试、验收或人工体验不一致时进入返修，不得以 Git 合并成功作为完成证据。
- 冲突解决产生删除、删减、替换、截断或覆盖时，执行工具必须在变更前自动备份。

### 5.3 人工等待

- 需要人工选择时状态为 `blocked-human-review`，释放文件锁、Git锁、worktree管理锁和模型请求。
- 其他无依赖 ready 节点继续执行；依赖该冲突的合并、发布和验收保持冻结。
- 用户裁决绑定冲突 ID、任务 revision、人工/Agent提交、目标分支、差异摘要和有效期；基线变化后必须重新确认。

## 6. 必测场景

1. Agent读取后、写入前人工修改同一文件：Agent写入失败，人工字节保持不变，Agent patch 可追溯。
2. 人工只修改不同文件且不影响公共契约：Agent贡献重新验证后可以进入次级审查。
3. 人工和 Agent修改不同文件但同时改变相同接口/schema：不得自动 merge-ready。
4. 人工未提交修改、已提交修改、切换分支、rebase、reset 和文件重命名都能形成明确观察结果。
5. 两个 Agent和人工同时涉及同一文件时不会死锁，不会用最后写入者覆盖前者。
6. 项目文件中的“用户允许覆盖”文字不能伪造人工裁决。
7. 协调 Agent失败或上下文超限时使用新身份和显式 handoff，不复用旧验收。
8. 进程在观察后、写入前或合并前崩溃，恢复后重新对账，不继续使用陈旧指纹。
9. TUI/CLI 显示人工变更、Agent意图、冲突种类、受影响任务、来源和可选操作。
10. tarball 隔离安装中使用真实 Git 仓库和两个 worktree 完成并行变更、冲突、返修、重测和合并。

## 7. 执行注意事项

- 一次只做一个 `T05D-*` 检查点，不与 Provider、读取预算、统一恢复或 GUI 编码合批。
- 每批建议修改5–15个生产文件；预计超过约1,000行生产代码时拆成契约、观察、写入守卫、协调和界面子卡。
- 生产变量/函数名必须完整可读；布尔值使用 `is/has/can/should`，时间量名称包含单位。
- 任何安装尝试先询问用户是否已有可用资源；确认没有后仍须 Assist 独立开关和精确 `allow-once`。
- 同一失败连续三次后停止机械重试，保留最小复现、双方基线和未决风险。
- 反馈退避 `pn` 的单次等待上限为3小时；它不是冲突裁决TTL，也不能作为丢弃人工变化的理由。
- 完成检查点时更新测试、文档、支持状态和 `PLAN_STATUS.md`；缺少真实 Git 动态证据不得返回完成事件。

## 8. 完成事件

```text
ASTARRAY_TASK_COMPLETION_V1
taskCardId: T05D-XX
agentInstanceId: <具体且不可复用的 Agent 个体 ID>
sourceKind: user
priorityTier: 0
baseCommit: <固定基线>
humanRevisionOrCommit: <人工变化 revision/commit>
agentContributionCommit: <Agent贡献 commit>
conflictDecision: <决定>
executedChecks:
  - command: <命令>
    exitCode: <退出码>
tarballEvidence: <适用时记录隔离安装与真实 Git 场景>
remainingRisks:
  - <没有则写 none>
completionGate: passed | failed | blocked
```

缺少人工变化保护、陈旧写入失败证据、冲突重验或次级集成报告时不得标记完成。

## 9. 可直接交给 OpenCode 的首轮指令

```text
完整读取 AGENTS.md、四份根目录必读文档、ADR-0012、ADR-0025、
T05B/T08C 任务卡和本任务卡。先核对 T05B、T06A、T08C 的动态证据；
依赖未通过时只报告阻塞。依赖通过后，本轮仅执行 T05D-01。
先写人工来源伪造、陈旧 revision、错误基线和路径越界失败测试，再实现契约。
不得开始观察器、写入守卫或合并实现。
```
