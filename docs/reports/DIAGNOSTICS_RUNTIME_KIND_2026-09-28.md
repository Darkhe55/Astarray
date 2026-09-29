# 诊断面 runtimeKind（检查点，2026-09-28）

> 目的：产品入口必须能**直接证明**"选到的是 provider 而不是 mock"，不能只靠 CLI 退出码或选项面间接推断（承接 GUI/MCP 运行时选择接线）。

## 实现

- `ApplicationRuntimeOptions` 新增 `runtimeKind?: "mock" | "provider"`；`ApplicationRuntime` 暴露同名只读字段（缺省 mock）。
- `AstarrayApplicationFacade.create` 把解析出的运行时种类注入运行时；`getRuntimeDiagnostics()` 增加 `runtimeKind`。
- tarball 验收脚本新增断言：默认 provider 路径必须报告 `provider`，显式 mock 应用必须报告 `mock`。

## 证据

- **反例**：新增 `tests/core/integration/sdk-runtime-kind-diagnostics.test.ts`（mock/provider 两例）修复前 2/2 失败（`expected undefined to be 'provider'`）。
- **绿**：该文件 + 身份/端口用例共 7/7 通过。
- **官方门禁（完整访问 + 默认 forks 池）**：构建成功；全量 **240 文件 / 1893 用例**；覆盖率 **93.05 / 85.43 / 93.35 / 93.07**；安全关键模块 **22/22**。
- **tarball 公开 SDK 入口验收**：全部通过（含新增 `runtimeKind` 断言）。

## 残留

- 三入口（`run` / `gui` / `mcp serve`）仍未统一到 `config provider` 的受保护凭据引用（当前读环境变量 API key）——下一检查点候选。
