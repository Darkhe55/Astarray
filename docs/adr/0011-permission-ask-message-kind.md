# ADR-0011：新增 permission-ask 消息类型（优先级位于 failure 与 ambiguous 之间）

- 状态：已接受（对 ADR-0003 优先级列表的显式增补）
- 日期：2026-08-12

## 背景

Assist 门禁产生 `permission-ask-pending` 时，Worker 必须把"拟调用内容 + 简要说明"结构化地送达用户裁决，仅靠 failure/ambiguous 字符串字段无法稳定承载工具名与参数。

## 决策

在反馈消息载荷中新增 `permission-ask` 类型：

```ts
{ kind: "permission-ask"; toolName: string; argumentsJson: string; explanation: string }
```

加入备份删除专用警告后，优先级序列为 `instruction > backup-deletion-warning > failure > permission-ask > ambiguous > success`（ADR-0003 的其余语义不变；授权控制消息走专用通道）。

## 后果

- Worker 在工具返回 `permission-ask-pending` 时上报 permission-ask；调度层转用户，用户裁决后以 instruction 下发（授权记入会话授权，参数变更需二次鉴权）。
- 冻结决策守卫测试同步更新；`permission-ask` 高于 ambiguous，避免与"任务模糊"竞争用户注意力。
