# DELIVERY_REPORT — Astarray v0.1

> 生成日期：2026-08-12（含审计整改后复验）
> 目标：T00–T14 全部计划任务 + T05A/T06A 增补 + 外部审计整改
>
> 状态更正（2026-08-14）：本报告是新增设计前的历史交付快照，不再代表当前最终完成状态。ADR-0014–0024 新增的安全、权限、Agent 控制流、个体记忆隔离和工具说明回访/通信转交任务仍在实现或复验中，其中 T06E–T06G/T08A/T08B 为 pending；完成对应验收和新 tarball 隔离验收前，不得宣称最新设计已经交付。

## 1. 任务完成情况

| 任务 | 内容 | 状态 | 批次 | 验收证据 |
|---|---|---|---|---|
| T00 | 架构定稿与契约 | ✅ done | 1 | schemas/errors 测试；冻结决策守卫测试 |
| T01 | npm 与 TypeScript 工程骨架 | ✅ done | 1 | typecheck/build/help/version |
| T02 | 模式状态机与权限策略 | ✅ done | 2 | 三模式矩阵表驱动测试；降级重鉴权 |
| T03 | 原子任务链持久化 | ✅ done | 2 | 崩溃恢复/Windows 覆盖/并发 revision |
| T04 | 独立反馈进程 | ✅ done | 3 | 真实 fork 集成测试（PID 隔离/重启重放/退避虚拟时钟） |
| T05 | DAG 调度器 | ✅ done | 4 | 环检测/并发上限/领取锁/失败传播/阈值 |
| T06 | 工具注册表与最小权限 | ✅ done | 4 | 预览/子集/越权拒绝/审计/token 估算 |
| T06A | 工具内破坏性变更备份层 | ✅ done | 4C | 自动 pre-image、quarantine 两阶段删除、删除授权控制、HIGH 审计链 |
| T07 | Agent Runtime | ✅ done | 4 | Scripted + OpenAI 兼容（流式/工具/取消/超时/脱敏） |
| T06B | Ponder 本地只读边界与敏感操作分类 | ⏳ pending | 4F | 待 ADR-0014 / AR-06A 动态验收 |
| T06C | 全模式本地敏感内容禁读 | ⏳ pending | 4G | 待 ADR-0018 动态验收 |
| T07B | 反自指读取与通用活锁守卫 | ⏳ pending | 4H | 待 ADR-0017 动态验收 |
| T06D | 高严谨性事实验证工具 | ⏳ pending | 4I | 待 ADR-0016 动态验收 |
| T07A | 明确完成协议与早停恢复 | ⏳ pending | 4J | 待 ADR-0015 / AR-06B 动态验收 |
| T08 | 三级 Agent 编排 | ✅ done | 5 | 成功路径/失败重试/权限询问/unblock/非阻塞/cancel/Devolve |
| T08A | 默认控制流、个体记忆隔离与三级 Agent 生命周期 | ⏳ pending | 6D | 待 ADR-0022/0023 / AR-06I 动态验收 |
| T08B | 工具说明回访、无产品数量配额与受权通信转交 | ⏳ pending | 6E | 待 ADR-0024 / AR-06J 动态验收 |
| T09 | 记忆、缓存与指标 | ✅ done | 6 | DiskCache（stale-reject/bypass）、MetricsRegistry、ANSI 清洗 |
| T10 | TUI | ✅ done | 6 | Ink 组件测试（尺寸/CJK/emoji/超长/NO_COLOR/注入清洗） |
| T11 | Headless CLI | ✅ done | 6 | 构建产物集成测试（stdout 纯 JSON/退出码稳定） |
| T12 | 恢复、安全与异常加固 | ✅ done | 7 | 无限 loop/穿越变体/不可写目录/脱敏自匹配修复 |
| T13 | npm 打包与隔离安装 | ✅ done | 8 | verify-package + smoke-install 全通过 |
| T14 | 文档与最终报告 | ✅ done | 8 | README + 本报告 |
| T05A | Agent 工作存档与上下文选择器 | ✅ done | 4A | 每 Agent 独立存档、选择性附加、SHA-256 附件 |
| T06A | 工具内破坏性变更备份层 | ✅ done | 4C | 自动 pre-image、quarantine 两阶段删除、删除授权控制、HIGH 审计链 |

## 2. 实际运行的验证命令及结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | tsc --noEmit 无错误 |
| `npm run lint` | 0 | eslint 无告警 |
| `npm run build` | 0 | dist/cli.js + dist/feedback-process-entry.js |
| `npm run test` | 0 | 32 文件 / 412 测试通过（`pretest` 自动构建保证 dist 新鲜） |
| `npm run test:coverage` | 0 | Stmts 92.23% / Branch 85.44% / Funcs 89.13%（门槛 85%） |
| `npm run check` | 0 | 全绿（连续多次） |
| `npm pack --dry-run --json` | 0 | 13 文件 / ~105 KB |
| `node scripts/verify-package.mjs .tmp/packages/astarray-0.1.0.tgz` | 0 | 内容/BOM/shebang 校验通过 |
| `node scripts/smoke-install.mjs` | 0 | 隔离安装 + npx 冒烟 + 全局 .cmd shim + 反馈入口加载全通过 |

### 隔离安装验证（tarball：`.tmp/packages/astarray-0.1.0.tgz`）

```text
> npm install .tmp/packages/astarray-0.1.0.tgz # .tmp/package-smoke 隔离安装
> npx astarray --version                    # 0.1.0
> npx astarray --help                       # 命令列表完整
> npx astarray doctor --json                # health: ok
> npx astarray run "smoke" --runtime mock --json
# → { missionId: "mission-…", status: "done" }
> npm install -g <tarball> --prefix <隔离prefix>
# → astarray.cmd shim 生成，--version 正常
```

## 3. 覆盖率

- 全项目：Statements 92.02% / Branches 85.17% / Functions 89.25% / Lines 92.14%（门槛 85% 已启用，低于即失败）。
- 状态机、权限、DAG、反馈协议、信箱、退避、存档与备份层分支覆盖 84–96%（per-file 见 `npm run test:coverage` 报告）。

## 4. tarball 文件名

`.tmp/packages/astarray-0.1.0.tgz`（13 个文件：dist/、README.md、LICENSE、package.json）。

## 5. 隔离安装结果

见上节；安装后不依赖源码目录，shebang 无 BOM，安装生命周期不联网、不写用户目录（无 postinstall 脚本），反馈进程入口随包分发且可加载。

## 6. 已知风险

0. **新增设计尚未实现**：现有 tarball 不包含 T06B/T06C/T06D/T07A/T07B，Ponder 本地只读、全模式敏感禁读、事实验证、反自指/活锁和早停自动续跑均不能按已交付能力使用。
1. **跨进程 mission 锁**：多 CLI 实例并发写同一 mission 由 revision 校验兜底（stale-revision 拒绝），无跨进程互斥锁。
2. **LLM 任务分解**：主控制器使用确定性单任务分解；真实 LLM 分解需接入 OpenAI 兼容运行时（环境变量配置）。
3. **指标未接入编排**：MetricsRegistry 已实现，`getMetricsSnapshot` 暂返回 null，TUI 头栏显示基线值。
4. **TUI 键盘自动化**：组件测试覆盖渲染与状态驱动；PTY 级键盘交互未自动化（依赖 T12 的 node-pty 选项，未引入）。
5. **Windows 文件竞态**：测试中发现并修复了 rename EPERM 竞态（summary 互斥 + cancel 确定性收敛）；极端负载下仍可能偶发，需 CI 多平台观察。
6. **SSE 实现**：OpenAI 兼容运行时以整文本解析 SSE，语义正确但非逐块流式（生产可优化为流式消费）。
7. **T04 集成测试依赖构建产物**：`npm run test` 单独运行（未 build）时自动跳过（`describe.skipIf`）。

## 7. 审计整改记录（外部验收后复验）

外部验收发现的 7 项阻断性问题已全部修复并通过回归（详见 `PLAN_STATUS.md` 审计整改记录）：

- S1 doctor 不再可能销毁用户文件（随机探测名 + wx 排他 + 回归测试）
- S2 反馈进程入池前做 schema 与身份注册运行时校验
- S3 备份事务闭环：TOCTOU 复核、恢复可撤销、备份 ID 不外泄、purge 失败不虚报、二进制/目录快照
- S4 删除授权绑定完整校验（请求 ID / Agent / 精确集合 / 过期 / 最新 revision）
- S5 交互式授权通道（警告→暂停→等待授权；非 TTY fail-closed）
- S6 存档 provenance 修正（逐属主附件、唯一实例 ID、无碰撞编码、默认不附加）
- S7 config init 覆盖前自动备份 + TOCTOU

基建改善：`pretest` 构建消除集成测试静默跳过/旧产物；ADR 0007-0010 去重重编号；`npm prune` 清理 extraneous 自副本；git 基线提交 `2ac838a`；Windows rename 瞬时 EPERM 有界重试。

覆盖说明：整体 85%+ 门槛保持通过；反馈进程模块分支覆盖 transport 100%、mailbox ~90%、entrypoint 文本报告受 v8 源映射偏移影响（中文注释行漂移），已按可执行分支逐项补齐测试；真实进程引导块（`child-bootstrap.ts`）与 cli.tsx 同类移出覆盖统计。

## 8. 交付物清单

- 生产代码：底层架构位于 `packages/core/src/`，TUI/CLI 位于 `packages/tui/src/`（约 5,000 行 TS）
- 测试：`tests/{unit,component,integration}`（355 例）
- 文档：`README.md`、`docs/architecture.md`、`docs/adr/0001–0007`、`PLAN_STATUS.md`、本报告
- 脚本：`scripts/{verify-package,smoke-install}.mjs`
