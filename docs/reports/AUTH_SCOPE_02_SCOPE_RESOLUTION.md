# AUTH-SCOPE-02 范围判定、回执与复检 — 证据

> 检查点：AUTH-SCOPE-02（docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md，未跟踪用户文件）
> 前驱：AUTH-SCOPE-01（ADR-0039 冻结，提交 `cd37aa7`）。日期：2026-09-16
> 契约补充：docs/adr/0039-auth-scope-and-adjudication-matrix.md §9–16

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/tools/scope-resolution.ts`（新） | `resolveOperationScope`（已登记根 + realpath，S1–S7；未知即 S4）、`decideScopeAuthorization`（三模式 × 范围矩阵；deny 优先）、`ScopeApprovalReceipt` + `computeOperationFingerprint` + `verifyScopeApprovalReceipt`、`recheckBeforeExecution`、`resolveEscalationTarget`/`isValidEscalationPath` |
| `tests/core/integration/auth-scope-resolution.test.ts`（新，9 用例） | cwd/自述不影响判定、链接逃逸、前缀碰撞、跨根与未知、安装开关、矩阵、deny 优先、回执四态、执行前复检、升级路径 |

## 2. 行为反例（红→绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| cwd 或"这个操作在项目内"的自述把项目外操作判成 S1 | 只认已登记根 + 真实路径 | ✅ 自述被忽略（reasons 记录"不参与判定"），项目外目标判 `S3-project-external` |
| 符号链接逃逸 | 判项目外 | ✅ 注入解析器把 `rootA/link` 解析到根外 → S3 |
| 路径前缀碰撞（`proj` vs `proj-other`） | 不误判归属 | ✅ `proj-other/file` 归 `B` 且为 S1（不是 A 的子路径） |
| 跨根/不可解析目标被当成项目内 | S2 / S4 | ✅ `touchesAdditionalProjectRoots` → S2；`*.txt` 与 `process-execution+外副作用` → S4 |
| 安装开关关闭仍放行 | 拒绝 | ✅ 协同/放权均 `deny`、`requiresInstallationSwitch=true`；开关开启 + 协同 → `ask-user` |
| 矩阵混同 | 逐格正确 | ✅ 协同 S1→`ask-superior`（配置 allow 时上级自动批准）、S3→`ask-user`；放权 S4→`ask-superior`、S1→`allow`；思索只读 `allow`/写入 `deny`；S7→专用流程 |
| deny 被范围/模式覆盖 | deny 优先 | ✅ 三模式下 deny 均拒绝（含只读） |
| 回执可跨 revision/目标复用 | 失效并给原因 | ✅ `stale-revision`、`expired`、`fingerprint-mismatch`、`scope-mismatch` 分别命中 |
| 执行前不复检 | 链接变化被发现 | ✅ `recheckBeforeExecution` 在解析器变化后返回 S3 + `scope-mismatch` |
| 升级无限/循环回派 | 有界且不得回派 | ✅ 四级+S1→三级、三级+S3→次级；`["tertiary","quaternary"]`、`["secondary","tertiary","secondary"]`、空路径均 false |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| `npx vitest run tests/core/integration/auth-scope-resolution.test.ts` | 0；**9 passed** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| 全量门禁与推送 | 见 §5 |

## 4. 安装包与真实副作用

- 本检查点**未执行任何真实安装或外部软件操作**（避免隐式副作用）；安装类只消费开关状态并给出裁决。
- 接线到工具执行前门禁（含把 `WorkspaceBoundary` 的 `process.cwd()` 根替换为已登记项目根）属 AUTH-SCOPE-03。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| `npm run build` | **exit 0** |
| `npx vitest run --maxWorkers=6` | **exit 0：205 文件 / 1659 用例全通过** |
| `npx vitest run --coverage --maxWorkers=6` | **exit 0**：全局 statements **93.24%** / branch **85.46%** / functions **92.15%** / lines **93.30%**；`packages/core/src/tools` 目录 **95.40% / 90.39% / 97.06% / 95.40%** |
| `npx tsc --noEmit` / `npx eslint .` | 0 / 0 |
| `git push` | **失败（网络）**：本阶段累计 5 次尝试全部 `Connection reset by 20.205.243.166 port 22`（含 2 次审批通道 600s 超时未执行）→ 按常设规则跳过上传，累积待推送 `cd37aa7`、`9868b4e`、`85456a8`（+ 本记录提交） |

门禁并行度沿用前几轮结论：`--maxWorkers=6` 下稳定全绿（默认并行度会因资源竞争命中不同既有用例超时）。

## 6. 未满足项与后续

- **AUTH-SCOPE-03**：设置与公共入口接线、放权默认无人工等待、deny 生效、协同项目内批准/项目外等待人工、
  拒绝与重放零副作用、恢复与打包回归。
- `WorkspaceBoundary` cwd 根替换与工具执行前门禁接入是 03 的首要项（否则 S1 判定仍可被 cwd 污染）。
- 治理文档与既有测试预期的统一修订仍未开始（新用户文档要求正式启用前完成）。
