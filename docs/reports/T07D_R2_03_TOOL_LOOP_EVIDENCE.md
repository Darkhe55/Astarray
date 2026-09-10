# T07D-R2-03 工具与多层调度 · 证据

> 检查点：T07D-R2-03　状态：done
> 任务卡：`docs/tasks/T07D_R2_PROVIDER_PRODUCT_WIRING_TASK_CARD.md`；前驱：T07D-R2-02（done）
> 基线提交：`c95a1a0`；平台：Windows / Node v24.18.0 / npm 11.16.0

## 1. 行为反例（先红）

新增 `tests/core/integration/provider-tool-loop.test.ts`，首轮真实暴露产品缺陷：Provider 发起的 `readFile`
被**安装门禁**误拒（`安装门禁拒绝: 无可信交互通道`）——安装分类器把内部工具名当作“未知命令”fail-closed。

## 2. 实现内容

| 文件 | 变更 |
|---|---|
| `mission-orchestrator.ts` / `worker-agent.ts` | Worker 获得 `availableToolDescriptors`（按任务工具子集由注册表解析）并传给工具循环；Provider 首次在请求中看到 `tools` |
| `main-controller.ts` / `application-runtime.ts` | 新增 `resolveToolDescriptors`（默认按 `task.toolNames` 解析注册表描述符）与 `requireCompletionControlEvent` 透传 |
| `policy-wrapper.ts` | **安装门禁只对进程执行/系统级/未知副作用类工具生效**：内置只读/状态/备份类工具不再被命令分类器误判为安装尝试 |
| `worker-agent.ts` | 本地完成门禁：Provider 运行时必须给出 `ASTARRAY_TASK_COMPLETION_V1` 且声明本任务，否则记为失败 |
| `run-command.ts` / `cli.tsx` | `waitForTaskTerminal` 移除固定一分钟上限；新增可选 `--timeout-seconds`（缺省等待到终态） |
| `work-archive-store.ts` / `application-runtime.ts` | 存档追加即时回调 + 内存结果索引，消除“终态先于存档可见”的结果预览竞态 |

## 3. 场景与结果（经公共入口 + 本地 fake server）

| 场景 | 结果 |
|---|---|
| Provider 工具调用读取真实 fixture | 第二次请求体含 fixture 内容 `FIXTURE-CONTENT-42`，任务 `done` |
| 禁用/未注册工具（`shell`） | 工具错误回填给 Provider（`未注册/tool-not-found`），无执行痕迹；任务仍按声明收敛 |
| 缺少版本化完成控制事件 | 任务终态**不是** `done`（本地完成门禁拒绝结案） |
| CLI 等待策略 | 70s 虚拟时间仍未终态时继续等待，最终 `done`；显式 `timeoutMilliseconds` 超时返回 `running`；`failed` 立即收敛 `blocked` |

## 4. 命令、退出码与结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| 红灯（工具循环集成） | 1 | 安装门禁误拒 `readFile` |
| 绿灯（受影响 5 套件） | 0 | 34 通过 |
| `npm run check` | **0** | 153 文件 / 1416 测试全通过 |
| `npm run test:coverage` | **0** | 语句 93.86% / 分支 87.28% / 函数 91.07% / 行 93.94% |

## 5. 边界与后继

- 本轮完成“事件存在 + 声明本任务”的完成门禁；`LocalCompletionVerifier` 的 revision/证据包全量校验尚未接入循环（留待 `E2E-01` 与后续验收）。
- 非 2xx 仍统一映射 `provider-timeout`（错误码粒度问题继续记录）。
- 真实服务与费用授权属 `T07D-R2-04`；缺凭据时该检查点保持 blocked。
