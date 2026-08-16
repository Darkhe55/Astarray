# ADR-0010：受控备份访问与按模式删除策略

## 状态

Accepted — 2026-08-12

## 决策

提供两个分离入口：

- `backupVault`：`list / read / restore`。自动创建备份不经过模型，但 Agent 可在后续显式调用该受控工具；读取内容经过权限与脱敏检查，底层对象路径、哈希和恢复密钥不暴露。恢复前自动备份当前目标。
- `deleteBackup`：唯一可删除备份的特权入口，不作为 `backupVault` 的普通 action。

模式中文名称固定为：Ponder＝思索模式、Assist＝协同模式、Devolve＝放权模式。

删除策略：

- 思索模式：可使用 ADR-0014 定义的本地只读项目查看工具，但禁止 `backupVault`、`deleteBackup` 和所有会暴露或改变备份状态的工具。
- 协同模式：发出明确风险警告，将发起 Agent 设为 `awaiting-user-authorization` 并暂停。用户授权必须是单次的，绑定请求 ID、Agent ID、精确备份 ID、vault revision 和短有效期；禁止会话记忆。拒绝、超时或参数变化均不得删除。
- 放权模式：不提示、不等待，直接执行；必须写入 append-only 哈希链审计账本，记录查阅优先级为 `HIGH`，且删除入口无权删除该账本。

## 防递归与防死锁

删除备份是“删除前自动备份”规则的唯一例外，否则会无限递归。删除采用两阶段协议：

1. 不持锁等待用户授权。
2. 取得授权后短暂锁定 vault，校验 revision、引用关系和授权参数。
3. 原子地把 manifest/object 引用标记并移入 quarantine，提交审计记录后释放锁。
4. 独立清理器在锁外物理 purge；失败可从 quarantine 状态恢复。

`awaiting-user-authorization` Agent 不接收普通反馈，但专用授权控制通道允许与当前请求 ID 精确匹配的决定进入，避免暂停后无法收到授权。并发删除使用稳定锁顺序、短锁和 revision 校验；不得在持有 Agent、mailbox 或 vault 锁时等待用户或外部 I/O。

## 结果

- 备份可被合法读取和恢复，同时保持底层存储隔离。
- 协同模式下用户对永久降低恢复能力的操作拥有最终控制权。
- 放权模式保持无交互执行，但高优先级审计使行为易于追查。
- 特权例外、quarantine 和不可删除审计账本避免递归备份与锁等待环。
