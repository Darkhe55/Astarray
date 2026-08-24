# ADR-0028：人工与 Agent 并行编码、冲突协调与受控合并

- 状态：已接受，待实现
- 日期：2026-08-22
- 决策范围：人工工作树所有权、编辑意图、变化观察、陈旧写入拒绝、冲突分类、次级集成责任
- 对应任务：T05D

## 背景

T05B 建立了 Agent—Agent Git 分流：三级/四级 Agent 只提交自己的隔离分支，次级 Agent 负责项目级审查与合并。但人工开发者和 Agent 在同一项目周期并行编码时，若 Agent 在人工修改之后仍按旧基线写入，会静默覆盖或丢弃人工工作。

## 决策

### 1. 人工工作树所有权

- 默认禁止人工和 Agent 写同一个工作树。用户当前工作树/分支归人工控制，Agent 使用次级管理的独立 worktree（`worker/<task>/<agent>` 与 `reconcile/<task>/<agent>`）。
- Agent 不能把人工工作树作为自己的 worktree，也不能通过绝对路径、符号链接、Git `-C` 或环境变量绕过绑定。
- 人工工作树只能由人工或用户显式调用的受控集成动作修改。

### 2. 编辑意图与变化观察

- 编辑意图（AgentEditIntent）是协作元数据，不是强制文件锁：人工可以随时修改文件，Agent 必须检测变化并停止陈旧写入。
- 人工变化（HumanChangeObservation）只能来自本地控制面观察：认证用户来源、提交标识、变更路径、规范资源指纹与观察时间；模型不能伪造这些字段。
- 系统只能保留已观察快照与拒绝 Agent 覆盖，不得虚构"已自动备份人工操作"；Agent 自己的破坏性操作仍走工具内自动备份。

### 3. 陈旧写入拒绝

- Agent 每次实际写入前比较读取基线时与当前目标的规范化身份、内容指纹、Git blob 与工作树状态；任一不一致返回 `stale-human-change`。
- 检测到人工变化后，Agent 提交必须重新基于新人工版本返修，不得继续使用旧 pre-image。

### 4. 冲突分类与影响分析

- 无文本冲突不代表语义兼容：公共类型、schema、API、配置、迁移、锁文件与测试契约变化必须做影响分析和重新验收。
- 冲突决定四态：`no-overlap-revalidate` / `text-conflict-reconcile` / `contract-conflict-reconcile` / `blocked-human-review` / `agent-contribution-stale`。
- 没有明确用户裁决时，冲突只能进入返修或人工审查；不得自动 reset、checkout、stash、覆盖或选边丢弃人工变化。

### 5. 次级集成责任

- 项目级审查与合并仍只由具体次级 Agent 执行；三级/四级只能提交自己的隔离分支。
- 合并前目标分支、人工 HEAD、Agent 基线、贡献 HEAD、测试证据与验收结果必须绑定同一 revision；任一变化使旧 merge-ready 失效。

## 完成条件

- Agent 读取后、写入前人工修改同一文件：写入失败、人工字节不变、Agent patch 可追溯。
- 无重叠变化重新验证后进入次级审查；公共契约重叠不得自动 merge-ready。
- 人工未提交/已提交修改、切分支、rebase、reset、重命名均有明确观察结果。
- 协调失败用新身份与显式 handoff；崩溃恢复后重新对账，不继续使用陈旧指纹。
- TUI/CLI 显示人工变更、Agent 意图、冲突种类、受影响任务、来源与可选操作；tarball 隔离安装真实 Git 双 worktree 场景通过。