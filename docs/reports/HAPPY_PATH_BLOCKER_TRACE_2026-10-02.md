# 正向闭环阻断项：定位记录与未解矛盾（2026-10-02）

> 复跑前零额度正向探针发现：**授权成功后工具仍未执行、产物未生成**，因此**不申请真实复跑**。
> 本文件记录已确认事实与**未解矛盾**，供下一轮继续（诊断代码已全部移除，工作区干净）。

## 1. 现象（可复现，零真实额度）

假 Provider + 真实 CLI，脚本模拟正常路径（第 1 次调用 → 用户 `allow-once` → 第 2 次同参数重试 → 完成事件）：

```
授权:     已按精确参数 allow-once 授权 createProjectFile（作用域授权: granted）+ unblock ✅
工具结果: ① permission-ask-pending ② permission-ask-pending ③ auth-scope-replay-rejected
产物:     不存在
CLI:      非 done（失败收口）
```

## 2. 已确认事实

| 事实 | 证据 |
| --- | --- |
| 该拒绝来自**当前源码** | 在 `scope-authorization-gate.ts` 的重放分支文案前加 ASCII 标记 `[GATE-A]`，错误文本带上该标记 |
| 该分支位置 | `scope-authorization-gate.ts` 的 `authorizeForExecution`（重放分支，现约 500 行） |
| `authorizeForExecution` 的**唯一调用者** | `reserveForExecution`（全仓 grep 仅 2 处：定义 + 该调用） |
| gate 层语义正确 | `tests/core/integration/permission-refusal-side-effect.test.ts` 2/2：内层 `sideEffectStatus:"none"` 时不判待对账；拦截后重跑能落盘 |
| 环境变量链路正常 | 同一 spawn 方式下子进程能看到 `process.env`（实测 `child sees: 1`） |
| 构建包含诊断 | `ASTARRAY_RESERVE_TRACE` 注入后，`dist` 中确实存在 `reserve-trace` 字符串 |

## 3. 未解矛盾（下一轮入口）

> 在 `reserveForExecution` 注入细粒度审计后运行真实 CLI：
> **审计一次都没有输出**，但 `authorizeForExecution` 的重放分支错误却出现在工具结果里。

即"只能由 reserve 到达的分支报了错，而 reserve 没有运行"。可能解释（按优先级）：

1. **存在第二个 gate 实例或第二个执行路径**（当前只找到一处 `new ScopeAuthorizationGate`，
   但 `buildWorkerToolPort` 在模式装配处有两份，需确认是否共用同一实例）；
2. 工具结果是**我在探针侧采集到的旧消息**（请求体里回放的历史 tool 消息），
   而当前这一次运行实际没有产生该错误 → 需直接打印 CLI 自身 stderr 的完整工具结果序列区分；
3. 反馈子进程（`useFeedbackProcess: true`）里跑了**不同构建**的代码（子进程模块解析需实测）。

**建议下一轮第一步**：在 CLI 进程内打印
① 实际加载的模块路径（`import.meta.url` / `require.resolve` 结果）；
② gate 实例标识（构造时生成）并在 `reserveForExecution`、`authorizeForExecution` 两处同时带出；
③ 直接输出 CLI stderr 全量（不经过探针采集），确认那三条工具结果的真实来源。

## 4. 状态

- `npm run check` → **exit 0：258 文件 / 1980 用例**
- `HEAD == origin/main == f46a218`；诊断代码零残留；真实额度消耗 **0**
- 阻断项清单：① 产物缺失却 done → **已修复并红转绿**（`0324721`）；② 正向闭环执行 → **未解决**（本文件）
