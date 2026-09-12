# E2E-01-02 切片 6：产品级 侦察 与 规划 进入纵向流程

> 检查点：E2E-01-02（仍为 **in_progress**）
> 前驱：切片 5（tarball 纵向复现）。日期：2026-09-10
> 证据代码：`tests/core/integration/e2e01-vertical-recon-plan.test.ts`

## 1. 侦察（PROJECT_CONTEXT_DIGEST_V1）

经 CLI 装配入口（`bootstrapCli`）取得运行时：

| 断言 | 结果 |
| --- | --- |
| 侦察任务只读子集 | `allowedReadToolNames: ["project-read","project-search","project-status"]` 通过；含 `project-write` 时被拒（`task-sequence-permission-denied`） |
| 已登记来源写入摘要 | `recordDigest` 成功，`listDigests()` 返回该摘要（`digestId=digest-1`，绑定 `reconnaissanceAgentInstanceId`） |
| 新 revision 使旧摘要 stale | 同扫描范围写入 `digest-2` 后 `digest-1.isStale === true` |
| 未登记来源 | 被拒（`task-sequence-permission-denied`，"非空字符串不是认证"） |

**原限制（已在切片 6b 修复）**：运行时曾把侦察来源认证绑定到写死的 `mission-cli`/`bundle-cli`，
真实 mission 的侦察摘要无法写入；现改为按摘要 `scanningScope` 校验（见
docs/reports/E2E01_02_RECON_SCOPE_EVIDENCE.md）。

## 2. 规划（任务插入提案）

| 步骤 | 结果 |
| --- | --- |
| 发布目标次级的任务序列（本地控制面入口） | `taskSequenceManageController.publishSequence` 成功（revision 1→2） |
| 用户来源提案、层级 0 | 提交成功 |
| **Agent 来源提案、层级 0** | 被拒（`task-priority-denied`：不得把主 Agent 派生节点伪装成用户层级） |

## 3. 产品侧变更

- `ApplicationRuntime` 暴露 `reconnaissanceController` 与 `taskSequenceManageController`
  （二者此前已装配但未出现在运行时接口，公共入口无法使用）。
- `ProjectReconnaissanceController.listDigests()` 新增只读列出接口（主 Agent/CLI 按需读取）。
- **去重**：任务序列管理控制器此前被装配两次（提案控制面 + 直接派发控制面各一份，两个独立存储）；
  现为单一实例共享，避免序列 revision 分裂。

## 4. 命令、退出码

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；177 文件 / 1501 用例通过 |
| `npm run test:coverage` | exit 0；177 文件 / 1501 用例通过；全局 93.77% stmts / **86.65% branch** / 91.92% funcs / 93.81% lines |
| 聚焦 `e2e01-vertical-recon-plan` | 2/2 通过 |

## 5. 本检查点剩余

- 侦察来源认证改为按 mission/任务包校验（去掉写死的 `mission-cli`）。
- 纵向编排产品化：step 间编排仍在验收流程内（每步均为真实产品执行）。
- **E2E-01-03**：真实 Provider + 人工并发变化，仍待用户凭据与费用授权。
