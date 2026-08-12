# Astarray

仓库目录职责与最近一次整理记录见 [`ORGANIZATION.md`](./ORGANIZATION.md)。

TUI Agent 编排工具：单一主 Agent + Ponder / Assist / Devolve 三模式。主 Agent 派发任务后立即恢复接收用户输入；三级 Agent（主 → 次级调度 → 三级执行）通过**独立反馈进程**解耦通信，任务按 DAG 调度、按最小工具集授权执行。

## 安装与快速开始

需要 Node.js ≥ 20（支持 Windows / macOS / Linux）。

```powershell
npm install -g astarray
# 或本地安装后：
npx astarray --help
```

开发环境：

```powershell
npm install
npm run check
node dist/cli.js --help
```

### 冒烟验证

```powershell
npx astarray doctor --json
npx astarray run "分析当前项目" --mode assist --runtime mock --json
```

## 三种模式与权限模型

| 模式 | 中文名 | 权限 | 行为 |
|---|---|---|---|
| `ponder` | 思索模式 | 零工具调用 | 纯问答，不产生任何状态文件 |
| `assist` | 协同模式 | 白名单 + 门禁询问 | 受限工具调用前必须询问用户（附调用内容与说明）；会话授权默认 10 分钟 |
| `devolve` | 放权模式 | 完全控制（注册工具内） | 免逐次询问，但仍受工具注册表、工作区边界与操作系统权限约束 |

- 工具类别：`readonly`（直接允许）/ `restricted`（询问）/ `forbidden`（拒绝）；shell、删除、安装、发布、付款类默认不注册。
- 参数变更后必须二次鉴权；模式降级后所有后续调用按新模式重新鉴权。

## Provider 配置

v0.1 CLI 仅内置 `mock` 运行时（确定性、无凭据、可离线验证）。`openai-compatible` 运行时已实现（`packages/core/src/runtime/openai-compatible-runtime.ts`，流式 + 工具调用 + 超时/取消），通过环境变量接入：

```powershell
ASTARRAY_PROVIDER_BASE_URL=https://api.openai.com/v1/chat/completions
ASTARRAY_PROVIDER_API_KEY=sk-...
ASTARRAY_MODEL=gpt-4o
```

API key 永不进入日志、错误、快照或交付报告（脱敏层见 `packages/core/src/infra/redaction.ts`）。

## 状态目录与恢复

状态位于 `.astarray/`（当前工作目录）：

```text
.astarray/
├─ missions/<missionId>/
│  ├─ task-chain.json      # 版本化任务链（schema_version + 单调 revision）
│  ├─ task-chain.json.bak  # 原子替换备份
│  └─ summary.json         # mission 概要（模式/提示词/状态）
├─ feedback/mailboxes/     # 反馈进程持久化信箱
└─ config.json             # config init 生成
```

- 写入使用临时文件 + flush + 同目录原子替换；损坏文件从备份恢复，绝不静默覆盖。
- 崩溃后 `astarray resume <mission-id>` 从任务链恢复；投递后 ack 前崩溃由信箱重放（幂等键去重）。

## Headless 用法

```powershell
astarray run "任务" --mode assist --runtime mock --json
astarray status [mission-id] [--json]
astarray resume <mission-id> [--json]
astarray cancel <mission-id> [--json]
astarray doctor [--json]
astarray config init
```

- `--json` 模式 stdout 只输出机器可解析结果，日志与警告写 stderr。
- 退出码：`0` 成功，`1` 执行失败，`2` 用法/参数错误。

## 独立反馈进程

- 形态：独立进程（`child_process.fork`），主进程负责启动、健康检查、优雅关闭与崩溃重启；崩溃后重放未确认消息。
- 投递语义：普通消息仅在接收 Agent `idle` 时投递；投递成功并收到 ack 后才消费；同优先级严格 FIFO，优先级 `instruction > failure > permission-ask > ambiguous > success`。
- 退避：接收者忙碌时等待质数秒（2, 3, 5, 7, 11…），单次上限 3 小时；新消息入池即重置到 2 秒。
- 排错：`doctor --json` 检查反馈进程入口存在性；子进程诊断日志继承 stdout/stderr；主进程退出时子进程自动退出（心跳看门狗 + disconnect 监听）。

## TUI

TTY 下直接运行 `astarray` 进入全屏 TUI：

```text
Tab: 切换面板  Ctrl+M: 模式  Ctrl+N: 新任务  Ctrl+C: 取消/退出  ?: 帮助
1/2/3/4/Esc: 权限弹窗决策
```

要求最小 80×24 终端；支持动态缩放、`NO_COLOR=1`、中英文与 emoji；模型/工具输出中的 ANSI/OSC 序列在 UI 边界统一清洗。

## 跨平台差异、安全边界与数据清理

- Windows：原子替换使用 `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`；全局安装 shim 为 `astarray.cmd`；信号处理与子进程清理已覆盖。
- 安全边界：路径穿越（`../`、绝对路径、UNC、符号链接逃逸）在工作区边界拒绝；工具分类精确名称匹配不可绕过；非幂等操作不确定时进入 `blocked` 等待人工裁决。
- 数据清理：删除 `.astarray/` 即清理全部任务/信箱/缓存数据；Ponder 不写任何文件。

## 当前限制

- 任务分解使用确定性单任务（真实 LLM 分解由次级 Agent 运行时演进）。
- `openai-compatible` 运行时需配置环境变量；headless `--runtime` 仅 `mock`。
- 指标面板当前显示基线值（MetricsRegistry 已实现，尚未接入编排循环）。
- 多 CLI 实例并发写同一 mission 由 revision 校验兜底（跨进程锁为后续演进项）。
