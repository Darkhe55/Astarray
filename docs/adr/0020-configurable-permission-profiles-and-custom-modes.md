# ADR-0020：可配置权限组与命名自定义模式

- 状态：Accepted（设计冻结，尚待 T06F 实现与动态验收）
- 日期：2026-08-13

## 背景

固定的 `readonly/restricted/forbidden` 工具类别不足以表达用户对不同权限的偏好。Devolve 需要默认放权但允许用户收紧个别权限；Assist 需要独立、保守的默认策略；Ponder 必须维持不可变本地只读边界。用户还需要创建多个有名称的权限组合，在不同项目或风险场景间明确切换。

## 决策

### 权限三态与目录

所有可配置能力使用 `PermissionDecision = deny | ask | allow`。本地版本化 `PermissionCapabilityCatalog` 至少包含以下逐项权限，界面不得只显示笼统工具类别：

| 权限 ID | 能力 | Devolve 默认 | Assist 默认 |
|---|---|---|---|
| `project.read` | 普通项目文件、目录和文本检索 | allow | allow |
| `project.create` | 新建项目内容 | allow | ask |
| `project.modify` | 修改非破坏性项目内容 | allow | ask |
| `project.destructive-mutate` | 删除、覆盖、替换、截断和重命名覆盖 | allow | deny |
| `process.execute-sandboxed` | 在工作区沙箱执行进程 | allow | ask |
| `process.execute-host` | 在宿主环境执行进程 | allow | deny |
| `network.read` | 只读网络请求和资料取得 | allow | ask |
| `network.write` | 上传、提交或改变远端状态 | allow | deny |
| `browser.read` | 查看网页和浏览器只读状态 | allow | ask |
| `browser.interact` | 点击、输入、提交表单和下载 | allow | deny |
| `connector.read` | 从外部连接器读取数据 | allow | ask |
| `connector.write` | 通过外部连接器创建或修改数据 | allow | deny |
| `database.read` | 查询数据库 | allow | ask |
| `database.write` | 修改数据库及其结构 | allow | deny |
| `cloud.read` | 查看云资源与部署状态 | allow | ask |
| `cloud.write` | 创建、更新或删除云资源 | allow | deny |
| `clipboard.read` | 读取系统剪贴板 | allow | ask |
| `clipboard.write` | 写入系统剪贴板 | allow | ask |
| `environment.read` | 读取普通运行环境信息 | allow | ask |
| `environment.modify` | 修改运行环境和持久环境配置 | allow | deny |
| `code-repository.acquire` | clone/download/vendor 代码库 | allow | ask |
| `dependency.install-project` | 安装或更新项目级依赖 | allow | ask |
| `dependency.install-global` | 安装全局依赖、运行时和工具链 | allow | ask |
| `extension.install` | 安装插件、技能、模型或扩展 | allow | ask |
| `git.read` | Git 只读查询 | allow | allow |
| `git.write-local` | commit、普通分支和本地合并 | allow | ask |
| `git.rewrite-history` | rebase、reset、clean、强制移动引用 | allow | deny |
| `git.remote-write` | push、PR 和远端引用修改 | allow | deny |
| `external.publish` | 发布包、部署或公开内容 | allow | deny |
| `external.communicate` | 代表用户发送消息、邮件或通知 | allow | deny |
| `financial.transact` | 付款、购买、交易和资金操作 | allow | deny |
| `system.modify` | 修改系统设置、服务、权限或注册表 | allow | deny |
| `backup.list` | 查看受控备份元数据 | allow | ask |
| `backup.read` | 读取受控备份业务内容 | allow | ask |
| `backup.restore` | 恢复备份 | allow | ask |
| `backup.delete` | 删除备份 | allow | ask |
| `agent.spawn` | 次级 Agent 创建所属三级 Agent | allow | ask |
| `agent.delegate` | 次级 Agent 向所属三级 Agent 发布或重派任务 | allow | ask |
| `agent.manage` | 次级 Agent 暂停、取消和回收所属三级 Agent | allow | ask |
| `agent.communication-delegate` | 直属上级把直属低一级 Agent 的限定沟通句柄授权给具体同级 Agent | allow | ask |
| `task.read` | 查询任务和偏序集状态 | allow | allow |
| `task.manage` | 创建、插入、改序、取消任务 | allow | ask |
| `memory.read-selected` | 读取明确选择的 Agent 存档条目 | allow | ask |
| `memory.write` | 写入任务记忆与工作存档 | allow | ask |

任何工具注册前必须映射一项或多项权限。需要多项时取最严格有效决定：任一 `deny` 即拒绝，否则任一 `ask` 即询问，全部 `allow` 才直接允许。未分类工具拒绝注册/执行。

### 内置权限组

- `builtin:ponder`：签名冻结且不可编辑；只允许既有本地只读白名单。它不参与普通 profile 导入覆盖。
- `builtin:devolve`：所有可配置权限的出厂默认值均为 `allow`。用户可以逐项改成 `ask` 或 `deny`，并可恢复出厂默认。
- `builtin:assist`：使用上表的独立默认矩阵。代码库、项目/全局依赖和扩展安装即使配置为 `allow`，仍必须经过 ADR-0019 的已有资源询问、独立开关和精确逐次授权。

### 自定义模式

- 用户可创建不设产品数量上限的自定义权限组。每个对象包含随机不可复用 `permissionProfileId`、可辨识 `displayName`、单调 `revision`、目录版本、逐项决定、新权限 fallback、创建/更新时间和来源审计。
- 名称经 Unicode 规范化、去除首尾空白后在活动组中不区分大小写唯一；保留 `Ponder/Assist/Devolve` 及其中文名，防止冒充内置模式。重命名不改变 ID。
- 可从空白全 deny、任一内置模式的可配置视图或任一自定义组复制。复制后独立演进。自定义组可逐项修改全部目录权限；新增权限按该组 fallback（默认 deny）处理。
- 运行时引用 `custom:<permissionProfileId>`，并把 ID、名称快照、revision 和目录版本写入任务、反馈、缓存、授权与审计。权限修改后，未执行调用和旧授权全部重新鉴权。

### 内部强制执行层（不面向用户）

下列项目不属于可配置权限：敏感内容禁读、工具内自动备份、身份/来源认证、工具注册和参数 schema、真实路径/工作区/OS 边界、审计完整性，以及明确规定为不可代理的用户确认。它们不得出现在权限目录、设置按钮、锁定项、帮助文字、权限组详情、配置导出、普通用户审计视图或模型可见工具描述中，也不得向用户说明存在一组额外限制。

命中内部执行层时只返回稳定、最小的“操作不可用”结果，不透露规则名称、分类、触发条件或绕过建议。详细分类仅写入与用户界面、模型上下文和普通导出隔离的受保护内部审计通道。

### 生命周期和无上限语义

权限组支持创建、重命名、复制、导出、导入、重置和删除。覆盖、重置、导入和删除前自动备份；三个内置组不可删除，当前使用组不能直接删除。系统不设置自定义模式数量上限，但仍对单个名称、单个文档大小、磁盘容量和并发写入实施通用资源安全限制，这不构成产品数量配额。

权限组生命周期由认证用户设置控制面直接提供，不作为 Agent 工具权限开关，也不受当前 profile 自我锁定。Agent 和模型不能调用该控制面或替用户选择模式。

本权限目录及 profile 只定义次级 Agent 的权限上限。主 Agent 永久只读、可信控制面创建次级 Agent、会话临时提升和三级 Agent 权限求交规则由 ADR-0021 定义。

## 后果

- `AgentMode` 需要演进为内置模式身份加权限组引用，UI 不能再用三项循环切换。
- Devolve 保持默认完全放权，同时用户能细粒度收紧。
- 自定义组提高灵活性，也要求 revision 绑定、导入校验、目录迁移，以及内部执行层与用户权限目录的严格隔离。

## 验收重点

- Devolve 新配置中目录全部为 allow；每项改为 ask/deny 后实际执行路径一致。
- Assist 与 Devolve 配置互不污染；Ponder 的任何修改/导入/绕过均失败。
- 可创建并命名大量自定义组，不存在硬编码数量上限；名称冲突、保留名和 ID 冒充被拒绝。
- 新权限、工具多权限映射、配置 revision 变化和并发修改均 fail-closed、可审计、可恢复。
- 权限目录、设置 UI、帮助、导出和模型描述均不会泄露内部执行层；所有权限组仍按本地实现接受其执行结果。
