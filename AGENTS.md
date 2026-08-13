# Astarray — Agent 工程指引

本仓库由 OpenCode 按 `IMPLEMENTATION_PLAN.md` 分批实现。开始编码前必须读取：

- `agent-main-architecture.md`
- `designtodo.txt`
- `IMPLEMENTATION_PLAN.md`
- `PLAN_STATUS.md`

## 常用命令

```powershell
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run test        # vitest run
npm run test:coverage
npm run build       # tsup
npm run check       # typecheck + lint + test + build
npm pack            # 打包前自动运行 prepack(check)
```

## 强制规范

- 生产代码变量/函数名必须含义完整，禁止无语义缩写（见实施计划 §3）。
- 布尔变量使用 `is`/`has`/`can`/`should` 前缀。
- 时间量命名必须带单位（如 `deliveryDelaySeconds`）。
- 核心领域代码（`packages/core/src/core`）禁止使用 `any`。
- 权限在工具实际执行前检查，不只派发时检查。
- 反馈工具为独立进程，不得退化为进程内定时器或协程。
- 每条反馈消息必须携带经过 schema 校验的信息来源；Agent 来源必须具体到不可复用的 `agentInstanceId`，转发时保留原始来源。
- 每个次级、三级 Agent 使用自己的工作存档文件；上级仅可按需选择条目附加，禁止默认注入完整存档。
- 涉及 Git 写入的多 Agent 任务必须由次级 Agent 负责分支/工作树分流、差异审查、测试验证和受控合并；三级 Agent 只能提交到分配给自己的隔离分支，不得自行合并、变基、推送或删除分支。
- 每个调度 Agent 必须在自己的记忆存档域维护独立的待办任务偏序集；任务发布者可指定插入前驱/后继。用户任务默认优先级层级 0，Agent 或工具生成的任务只能使用层级 1 或更低优先级；调度从当前可执行节点中按优先级、同级稳定顺序选取。
- 任何删除、文本删减、替换、截断或覆盖必须由执行工具在变更前自动备份；自动备份过程不经过模型。后续只能经受控备份工具读取或恢复。
- 删除备份使用独立特权入口：协同模式必须警告、暂停发起 Agent 并逐次取得用户授权；放权模式不提示但写入高查阅优先级审计日志。
- 模式中文名称固定为：Ponder＝思索模式、Assist＝协同模式、Devolve＝放权模式。
- 打包验收必须以 tarball 隔离安装为准。
