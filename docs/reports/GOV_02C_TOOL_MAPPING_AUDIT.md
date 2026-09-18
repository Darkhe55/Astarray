# GOV-02c 工具 → 操作映射显式化与安装路径可达性审计 — 证据

> 检查点：GOV-02c（治理迁移的映射/可达性收口）
> 前驱：GOV-02b（提交 1bac888、de11f67，已推送）。日期：2026-09-17
> 契约补充：docs/adr/0039-auth-scope-and-adjudication-matrix.md 补充 §30–32

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/tools/scope-authorization-gate.ts | `describeToolOperation` 为本地只读、无路径工具（`factVerification`、`taskSequenceStatus`）增加**显式白名单**分支并注释；默认分支明确注释"未映射不入门禁，未注册工具由注册表层 fail-closed 拒绝；新增安装/外部软件工具必须显式映射并提供本地范围证据" |
| tests/core/integration/scope-tool-mapping.test.ts（新，4 用例） | 全部内置工具显式映射或显式白名单；白名单工具直接执行；已映射工具（备份删除）未授权不触达内层；既有映射不变 |
| docs/adr/0039-auth-scope-and-adjudication-matrix.md | 补充 §30–32（映射显式化与可达性结论） |

## 2. 审计结论（安装执行路径可达性）

| 事实 | 证据 |
| --- | --- |
| 内置工具面共 11 个：readFile/listDirectory/writeFileTemporary/createProjectFile/replaceFileContent/backupVault/deleteBackup/taskSequenceStatus/searchProjectText/gitReadonlyView/factVerification | `BUILTIN_TOOL_DESCRIPTORS` |
| 无安装/进程执行/外部软件工具 | 工具名与安装分类器（npm/pnpm/yarn/pip/uv/poetry/cargo/apt/brew/… 与 clone/vendor）无交集 |
| `dependency-install`/`process-execution`/`external-software-control` 无工具映射 | `describeToolOperation` 映射表 |
| 旧 `InstallationGateGuard` 在当前工具名下不可达 | 分类器按 `commandName` 匹配包管理器命令；内置工具名均不匹配 |
| 未注册/禁用工具 fail-closed | `tests/core/integration/provider-tool-loop.test.ts`「未注册/禁用工具无法旁路」 |
| 本地只读、无路径工具 | `factVerification`/`taskSequenceStatus` 显式白名单（不进入门禁） |

## 3. 行为反例（先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 内置工具被隐式放行 | 每个内置工具都显式映射或显式白名单 | 通过 |
| 白名单只读工具被门禁拦住 | 直接执行（调用内层） | 通过 |
| 已映射工具未授权就执行 | 拒绝且不触达内层 | 通过（deleteBackup → S7 等待认证用户，执行次数 0） |
| 写入/读取/备份映射回归 | 判定不变 | 通过 |
| 未注册工具旁路 | 由注册表层拒绝（tool-not-found） | 通过（既有 provider-tool-loop 用例） |

## 4. 过程记录（诚实）

- 初版改动曾把默认分支改为 `unknown`（S4 人工裁决），导致未注册工具的错误被替换为范围授权等待，
  与 `provider-tool-loop.test.ts` 的"未注册工具无法旁路"冲突；已回退为默认 `null` 并保留显式白名单与注释，
  审计结论（未注册工具由注册表层 fail-closed）以既有测试为证据。
## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：227 文件 / 1821 用例全通过（+1 文件 / +4 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 93.05 / 85.17 / 93.05 / 93.07；scope-authorization-gate 93.42 / 86.76 / 92.85 / 93.33 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | **exit 0**（第 1 次尝试成功）：de11f67..b9a1f91 已推送 |

本检查点实现提交：`b9a1f91`（feat(auth-scope): GOV-02c 工具映射显式化与安装路径可达性收口）。

## 6. 未满足项与后续

- 引入安装/外部软件/进程执行工具（或桥接工具）时，必须按 §31 显式映射并提供本地范围证据；
  旧 `InstallationGateGuard` 届时需消费受信范围授权（GOV-02b 决策）而不是一律用户 allow-once。
- **GOV-02a 剩余**：`PLAN_STATUS.md` 等用户并行脏文件旧表述（待其落定）。
- 外部依赖：E2E-01 真实 Provider、GUI-01-R-04b 人工体验、BRIDGE-01-04 真实 MCP 客户端、WB-00-02。

