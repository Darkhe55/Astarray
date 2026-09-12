# E2E-01-02 切片 3b：受控的工作区新建文件通道（缺口 1）

> 检查点：E2E-01-02（仍为 **in_progress**）；前驱：切片 3（完成门禁修复）
> 日期：2026-09-10

## 1. 缺口与设计

切片 2 确认：worker 唯一能写工作区的工具 `replaceFileContent` 需要
`project.destructive-mutate`（assist 默认 **deny**），`writeFileTemporary` 只能写临时目录，
因此"实现"步骤没有合法写入通道。

**新增受控工具 `createProjectFile`（仅新建、不覆盖）**：

| 维度 | 取值 |
| --- | --- |
| 描述符 | `category: restricted`、`mutationKind: create-only`、`backupPolicy: not-required`（新建无 pre-image） |
| 权限映射 | `project.create`（devolve 默认 allow；assist 默认 **ask** → 无应答方时 fail-closed） |
| 敏感分类 | `file-mutation` |
| 实现 | 工作区解析 + 受保护存储策略断言（预检 + IO 前复检）；`flag: "wx"` 仅创建；目标已存在 → 拒绝覆盖（`EEXIST` 带 cause） |
| 完成门禁 | 已纳入 `MUTATING_TOOL_NAMES`：写失败未解决时不得以文本声明结案（切片 3 修复） |

## 2. 证据（先红后绿）

`tests/core/integration/e2e01-provider-write-probe.test.ts`（4 例，真实 provider 装配 + 本地协议服务器脚本化工具调用）：

| 用例 | 结果 |
| --- | --- |
| `replaceFileContent`（assist 默认） | 任务 blocked；桩文件保持 `E2E01_TARGET_NOT_IMPLEMENTED`（切片 3 回归） |
| 写操作失败后任务链 | `status !== "done"`；桩文件不变 |
| `createProjectFile`（assist 默认，project.create=ask） | **fail-closed**：任务不 done，目标文件不存在 |
| `createProjectFile`（devolve 默认，project.create=allow） | **真实写入** `.tmp/e2e01/probe-*/fixture-devolve/project/src/created-by-devolve.mjs`，任务 **done** |

新增用例在实现前失败（工具未注册 → 目标文件不存在、任务 blocked），实现后 4/4 通过。

## 3. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；174 文件 / 1496 用例通过 |
| `npm run test:coverage` | exit 0；174 文件 / 1496 用例通过；全局 93.69% stmts / **86.54% branch** / 91.67% funcs / 93.74% lines |
| 聚焦 | `e2e01-provider-write-probe` 4/4；既有工具/权限/worker 套件无回归（`builtins` 的 gitReadonlyView 用例属沙箱 spawn 限制，全量 check 下通过） |

首次覆盖率运行出现既有高负载偶发失败（`cli-commands` T12-04 用例），复跑全绿。

## 4. 本检查点剩余

- **切片 4（纵向编排）**：侦察→规划→实现→测试→独立验收→返修→次级集成→主报告按需读取；
  三角色身份不同；强制一次测试失败验证返修；拒绝未授权合并；主对话不被后台报告抢占。
  实现步骤现在有两条合法路径：devolve（默认 allow）或 assist + 显式授权
  （session 提升 / 权限组），E2E-01-01 fixture 仍是 assist，切片 4 需明确其授权来源。
- **切片 5**：tarball 隔离安装复现该场景；E2E-01-03 真实 Provider 待凭据与费用授权。
