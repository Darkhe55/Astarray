# GOV-02b 安装类范围细分与门禁分流 — 证据

> 检查点：GOV-02b（治理迁移的实现半：按范围分流安装授权）
> 前驱：GOV-02a（提交 f549fdf、9165bda，已推送）。日期：2026-09-17
> 契约补充：docs/adr/0039-auth-scope-and-adjudication-matrix.md 补充 §24–29

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/tools/scope-resolution.ts | `OperationDescriptor.installScopeEvidence`；`dependency-install` 证据充分且受控根落在已登记项目根内 → S1 子类，否则 S5；`decideScopeAuthorization` 增加 `operationKind` 并把安装开关约束覆盖到 S1 受控安装（assist/devolve） |
| packages/core/src/tools/scope-authorization-gate.ts | 预演与执行把 `operationKind` 传入矩阵判定（证据经 `OperationDescriptor` 透传） |
| tests/core/integration/auth-scope-install-routing.test.ts（新，9 用例） | 范围细分 + 决策矩阵 + 公共入口端到端 |

## 2. 行为反例（先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 无证据/证据不完整 | S5（fail-closed） | 通过 |
| 声明受控但受控根不在任何已登记项目根内 | S5（不采信自述） | 通过 |
| 有全局/外部副作用或未知安装脚本 | S5 | 通过 |
| 项目内受控 + 注册根命中 | S1 子类 | 通过：projectIdentifier=P，reason 含"项目内受控安装" |
| S5 未受控：开关关 → deny；开 → ask-user | 人工授权 | 通过 |
| S1 受控：开关关 → deny；开 + allow → 上级 allow；ask → ask-superior | 上级批准且仍要求开关 | 通过（requiresInstallationSwitch=true） |
| 放权模式 S1 受控：开关关 → deny；开 + allow → allow；ask → ask-superior | 按配置 | 通过 |
| 非安装 S1 操作 | 不受安装开关影响 | 通过（回归） |
| 公共入口：受控安装按上级批准并留回执 | isAllowed + adjudicator=superior-agent | 通过 |
| 公共入口：开关关闭 | `auth-scope-denied` 且无授权记录 | 通过 |
| 公共入口：未受控安装 | `auth-scope-awaiting-user-authorization` | 通过 |

## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npx vitest run tests/core/integration/auth-scope-install-routing.test.ts --maxWorkers=4 | 0；9 passed |
| npx vitest run tests/core/integration/{auth-scope-install-routing,auth-scope-resolution,auth-scope-gate}.test.ts --maxWorkers=4 | 0；28 passed（含 AUTH-SCOPE 回归） |
| npx tsc --noEmit / npx eslint . | 0 / 0 |

## 4. 设计边界

- 安装范围证据由本地安装门禁/安装计划生成；本模块只做确定性判定，不接受模型自述。
- 证据缺失或不完整一律 S5（保持旧行为）；这不改变既有 `assist-installation-gate` 的两阶段流程。
- 旧安装门禁测试中"任意安装逐次人工"的期望未被放宽；本轮只让**项目内受控**安装走上级批准路径。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：226 文件 / 1817 用例全通过（+1 文件 / +9 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 93.02 / 85.13 / 93.05 / 93.04；scope-resolution 89.58 / 82.06 / 91.66 / 89.51；scope-authorization-gate 90.66 / 83.33 / 92.85 / 90.54 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | 见提交记录 |

## 6. 未满足项与后续

- **GOV-02a 剩余**：`PLAN_STATUS.md` 等用户并行脏文件旧表述（待其落定）。
- 旧安装门禁（`assist-installation-gate`）测试期望的统一修订与安装计划证据生成接线仍属后续。
- 外部依赖：E2E-01 真实 Provider、GUI-01-R-04b 人工体验、BRIDGE-01-04 真实 MCP 客户端、WB-00-02。

## 7. 提交与推送

- 本检查点提交：`1bac888`（feat(auth-scope): GOV-02b 安装类范围细分与门禁分流）。
- `git push`：**exit 0**（第 1 次尝试成功，`9165bda..1bac888`）。

