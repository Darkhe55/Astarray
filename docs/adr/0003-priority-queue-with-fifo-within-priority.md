# ADR-0003：优先级队列 + 优先级内 FIFO

- 状态：已接受（冻结）
- 日期：2026-08-12

## 背景

消息存在跨类型优先级，同时要求同优先级严格有序。当前顺序为：`instruction > backup-deletion-warning > failure > permission-ask > ambiguous > success`。

## 决策

投递顺序采用"优先级队列 + 优先级内 FIFO"，不使用全局 FIFO。投递语义：普通消息仅在接收 Agent 为 `idle` 时投递；投递成功且收到 ack 后才从未投递集合消费。

## 后果

- 高优先级消息（如用户裁决 instruction、备份删除警告）可越过低优先级（success）。
- 同优先级内先到先投，顺序不因 ack 或重放错乱。
- 幂等键 + ack 保证重复投递可去重。
