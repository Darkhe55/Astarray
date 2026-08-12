# TUI 界面层

本目录承载 npm 可执行入口、Headless CLI、启动装配和 React/Ink 终端界面。

依赖规则：

- 可以依赖 `packages/core` 暴露的能力。
- 不得在界面组件中重复实现权限、备份、反馈投递或 Agent 调度规则。
- `ui/` 只处理展示、输入、焦点和终端适配；`cli/` 负责参数解析、启动装配与 JSON 输出。
- GUI 与 TUI 不得互相导入；共享业务能力必须下沉到 Core。

对应测试位于 `tests/tui/`。
