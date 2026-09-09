# ADR-0031：全局决策提升与局部上下文节点关闭及分级回访

> 状态：已接受（T09A-01 契约冻结）
> 日期：2026-09-09
> 关联：`agent-main-architecture.md` §11、`docs/tasks/T09A_CONTEXT_NODE_CLOSURE_AND_RECALL_TASK_CARD.md`

## 背景

长期任务把完整会话历史整体注入模型，token 成本随节点增长、旧信息干扰上升，重复摘要与普通缓存命中率无法真实反映上下文复用质量。需要把历史组织为可版本化、可恢复、按相关性受控注入的结构。

## 决策

1. **两类历史分离**：跨任务长期稳定内容进入**全局决策库**（可检索但默认不整体注入）；每轮模型可见内容受独立公开预算 `maximumGlobalContextTokenCount`（默认 4096 估算 token，认证用户可调/设 0，0 = 保留决策库但不自动注入）约束，实际上限取设置与 Provider 可用输入空间的较小值并预留系统/任务/输出空间。
2. **模型只能提议全局提升**：本地控制面完成来源、范围、哈希、冲突与 revision 校验后写入 `GLOBAL_DECISION_RECORD_V1`；状态为 `active/pending-human-review/disputed/stale/superseded`；覆盖式更新禁止，替代/状态变化用追加事件。记录状态 `pending-human-review` 不得被表述为用户已验收。
3. **局部上下文为 DAG**：每个具体 `agentInstanceId` 独占 `LOCAL_CONTEXT_GRAPH_V1`（节点/边/关闭状态），边类型 `required/optional/reference/supersedes/waived`；只有 `required` 参与闭包；任务完成事件与上下文关闭事件相互独立；`waived` 必须绑定认证用户与 revision。
4. **关闭资格**：节点本地验收通过 + 全部 required 直接子节点关闭或有有效豁免 + 无未决工具/权限/反馈/Git/失败/取消 + 全局提升完成。关闭=从普通提示词**逻辑排除**，绝不删除原文；物理清理仍走自动备份与破坏性门禁。
5. **人工验收推进策略**（两态）：`block-until-verified`（Assist 默认）/ `continue-with-deferred-review`（Devolve 默认）；延迟模式必须先原子写入 `DEFERRED_HUMAN_VERIFICATION_TASK_V1`（来源 system/tool、优先级 ≤1）并把节点标为 `deferred-review-closed`；事后否决 → 重开节点、标记全局记录 `disputed/stale`、失效缓存并创建返修，不做破坏性回滚。
6. **关闭胶囊与回访**：每个关闭节点生成不可变 `CONTEXT_CLOSURE_CAPSULE_V1`；回访请求 `ASTARRAY_CONTEXT_RECALL_REQUEST_V1` 的 `agentInstanceId` 由 harness 注入（schema 拒绝多余键），返回顺序固定 索引 → 胶囊 → 选定证据 → 有界完整片段；无范围“恢复全部历史”拒绝；敏感禁读/权限/反自指/活锁/任务累计预算/默认 10 文件工作集不可被回访绕过。
7. **缓存分四层**（全局决策块/活跃前沿/关闭胶囊/回访结果），键含相关 revision 与哈希；只缓存无副作用装配；失效按块精确。
8. **指标**：除 hit/miss 外记录可复用 token 比率、关闭节省率、回访率/重复回访率/有效回访率、过早关闭率、延迟验收否决率与下游扩散量等；用户新需求导致的重开不计为过早关闭。
9. **恢复**：关闭/提升/签字/回访/重开均追加事件 + 幂等 ID + 单调 revision + 原子快照；恢复由本地日志重建闭包，不依赖模型记忆。

## 后果

- 新增全局决策库、延后片段（`.astarray/agent-memory/<id>/deferred-context/`）、局部上下文图、胶囊、回访与设置存储，均按个体隔离并复用 T12A 恢复原语。
- T09A 完成后必须回归 T12A/T12 的恢复与安全路径。
- 模型上下文注入顺序固定：系统/安全规则 → 全局块 → 身份/工具 → 活跃前沿 → 必要证据 → 本轮输入。
