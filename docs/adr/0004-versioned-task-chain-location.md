# ADR-0004：版本化任务链 JSON 与固定路径

- 状态：已接受（冻结）
- 日期：2026-08-12

## 背景

任务切割、依赖关系与状态必须可恢复、可审计，并作为主 Agent 回答进度查询的事实源。

## 决策

任务链使用版本化 JSON，位于 `.astarray/missions/<missionId>/task-chain.json`。文档包含 `schema_version` 与单调递增 `revision`。写入使用临时文件、flush、同目录原子替换和备份恢复；损坏文件进入 recovery 流程，不得静默覆盖。

## 后果

- 优点：崩溃后可恢复旧版本；并发更新不会旧 revision 覆盖新 revision；审计与 TUI DAG 面板直接读文件。
- 代价：每次调度调整需原子写盘（进程内 mission 锁 + 同目录替换）。
