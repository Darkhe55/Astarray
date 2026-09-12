# E2E-01-02 切片 6b：侦察来源认证按 mission 校验（修复切片 6 限制）

> 检查点：E2E-01-02（仍为 **in_progress**）；前驱：切片 6（产品级侦察/规划）
> 日期：2026-09-10；证据代码：`tests/core/integration/e2e01-vertical-recon-plan.test.ts`

## 1. 问题

切片 6 记录的限制：运行时把侦察来源认证写死为 `mission-cli`/`bundle-cli`
（`application-runtime.ts` 的 `isRegisteredReconnaissance` 端口只传这两个常量），
因此**真实 mission 的 PROJECT_CONTEXT_DIGEST_V1 无法写入**。

## 2. 修复

| 层 | 变更 |
| --- | --- |
| 端口 | `ReconnaissanceSourceAuthenticationPort.isRegisteredReconnaissance(input)` 改为接收 `{ agentInstanceId, scanningScope }` 并返回 `{ valid, reason }`（不再返回裸布尔） |
| 控制器 | `recordDigest` 以摘要自身的 `scanningScope`（mission）作为认证作用域，失败原因透出（`侦察来源认证失败: <reason>`） |
| 目录 | 新增 `RegisteredAgentDirectory.verifyReconnaissanceSource({ reportingAgentInstanceId, missionId })`：要求来源已登记、角色为三级、且登记 mission 与侦察扫描范围一致（侦察摘要不要求绑定任务包） |
| 装配 | 运行时删除写死的 `mission-cli`/`bundle-cli`，改调上述目录方法 |

## 3. 证据（先红后绿）

`tests/core/integration/e2e01-vertical-recon-plan.test.ts`（修复前该用例失败：登记 mission 与扫描范围一致仍被"未登记"拒绝）：

| 断言 | 结果 |
| --- | --- |
| 登记 mission = `mission-recon-plan`，摘要 `scanningScope` 相同 | `recordDigest` 成功；`listDigests()` 返回 |
| 新 revision 摘要写入 | 旧摘要 `isStale=true` |
| 摘要 `scanningScope` 改为 `mission-other` | 拒（`task-sequence-permission-denied`，mission 不匹配） |
| 未登记来源 | 拒 |
| 侦察任务只读子集（`project-write`） | 拒 |

回归：`project-reconnaissance` 10/10、`standalone-workflow-runner` 5/5（两处测试装配端口按新签名更新）。

## 4. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；177 文件 / 1501 用例通过 |
| `npm run test:coverage` | exit 0；177 文件 / 1501 用例通过；全局 93.75% stmts / **86.65% branch** / 91.86% funcs / 93.79% lines |
| 聚焦 | `e2e01-vertical-recon-plan` 2/2、`project-reconnaissance` 10/10、`standalone-workflow-runner` 5/5 |

## 5. 本检查点剩余

- 纵向编排产品化（step 间编排仍在验收流程内，每步均为真实产品执行）。
- **E2E-01-03**：真实 Provider + 人工并发变化，仍待用户凭据与费用授权。
