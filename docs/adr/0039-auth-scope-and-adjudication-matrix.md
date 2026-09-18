# ADR-0039：按作用范围与裁决者的授权模型（AUTH-SCOPE）

- 状态：Proposed（AUTH-SCOPE-01 冻结；实现与治理文档修订随后续检查点分批落地）
- 日期：2026-09-16
- 来源：用户增量设计 `docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md`（未跟踪用户文件；本 ADR 为 Agent 派生冻结稿）

## 背景

旧规则把协同模式下的安装统一视为"任意安装均逐次人工授权"，但真实风险取决于**实际作用范围**
（项目内/项目根外/全局环境/安装脚本/外部软件控制）。按 cwd、路径字符串前缀或命令自述判断范围不可靠；
同时放权模式在无人介入时需要按已配置的上级裁决路由执行，而不是无限等待或把"用户离线"当作同意。

## 决策

1. **作用范围分类**（S 类，执行前由本地确定性判定）：
   - **S1 项目内已验证**：解析后的真实路径位于已登记项目根内，且副作用仅涉及项目内文件/进程。
   - **S2 跨项目根**：影响其他已登记项目根或同时跨多个根。
   - **S3 项目外副作用**：全局缓存、全局环境、系统目录、其他用户目录等。
   - **S4 范围未知**：无法证明受控（动态命令、shell 展开、无法解析的安装脚本、外部软件控制等）。
   - **S5 安装类**：代码库/依赖/运行时/插件/工具链/系统包，以及会执行安装脚本或改变依赖解析的操作。
   - **S6 外部软件控制**：启动、自动化控制第三方应用。
   - **S7 专用流程**：远端发布、备份删除等既有专用授权流程（**不因本 ADR 放宽**）。
2. **裁决者矩阵**：
   | 范围类 | 思索模式 | 协同模式 | 放权模式 |
   | --- | --- | --- | --- |
   | S1 项目内已验证 | 仅只读白名单 | 由**有权上级**批准后执行（可配置自动批准回执） | 默认 allow（可 deny/ask） |
   | S2 跨项目根 | 拒绝 | 逐次**认证用户**授权 | 默认 allow（可 deny/ask） |
   | S3 项目外副作用 | 拒绝 | 逐次**认证用户**授权 | 默认 allow（可 deny/ask） |
   | S4 范围未知 | 拒绝 | 逐次**认证用户**授权 | ask/上级裁决（不得按"用户离线=同意"） |
   | S5 安装类 | 拒绝 | 先询问已有资源 → 独立安装开关 → 逐次授权（开关关闭即拒绝） | 仍需安装开关与参数绑定 |
   | S6 外部软件控制 | 拒绝 | 逐次**认证用户**授权 | 默认 allow（可 deny/ask） |
   | S7 专用流程 | 拒绝 | 专用流程 | 专用流程（不放宽） |
3. **判定规则**：执行前解析真实路径（realpath、符号链接/junction）、目标文件、子进程、安装脚本、
   缓存/配置/环境写入等副作用；**不得**以 cwd、路径字符串前缀或命令自述作为范围依据；无法证明受控即归 S4。
   调用已登记的项目构建/测试工具，不因运行时二进制位于项目外就一律归 S6——必须有可验证的执行能力与副作用范围。
4. **升级与回派**：三级/四级请求沿直属上级；权限不得超过该次级当前有效上限；上报有界、去重、不得循环回派
   （ADR-0022、ADR-0025）。
5. **等待语义**：权限等待只暂停依赖该授权的节点，不冻结整个项目；规则变更不追认旧请求；
   在途操作在安全检查点对账后按新 revision 继续。
6. **旧规则迁移清单**（正式启用前统一修订，不在本检查点实施）：
   AGENTS.md 安装条款；`assist-installation-gate` 的协同安装语义与文案；
   安装门禁相关测试预期；`permission-capability-catalog` 安装/外部软件能力项；
   CLI/TUI 提示与导出配置文案；帮助文本。
7. **当前实现缺口（AUTH-SCOPE-02 范围）**：本地范围判定（仅 `WorkspaceBoundary` 的 realpath + 根内检查）、
   上级批准回执、逐级升级路由、执行前复检、安装脚本副作用识别、外部软件控制能力均**尚未实现/未接线**。

## 非目标

- 不实现通用 shell 的"完美静态副作用预测"；无法证明受控的命令走人工裁决或已登记的隔离执行能力。
- 不因本 ADR 放宽远端发布、备份删除等专用授权流程；准确性检查开关也不授予操作权限。

## 参考

- ADR-0018（敏感内容禁读）、ADR-0019（安装门禁）、ADR-0020/0021（权限组与主 Agent 只读）、
  ADR-0022（默认控制流）、ADR-0025（次级直投与四级委派）、ADR-0028（人类/Agent 并发修改）
- 用户增量设计：`docs/tasks/2026-09-16_INCREMENTAL_DESIGN_TASK_CARDS.md`（AUTH-SCOPE 段）
## 补充（AUTH-SCOPE-02 冻结：范围判定、裁决矩阵、批准回执与执行前复检）

9. **范围判定实现**（`packages/core/src/tools/scope-resolution.ts`）：
   只使用**已登记项目根**与真实路径解析（`realpath`，目标不存在时对最近存在祖先解析后拼回剩余段）。
   **不使用 cwd、路径字符串前缀或命令自述**；自述范围只记录在 `reasons` 中不参与判定。
10. **不可结构化解析即未知**：空路径、含控制字符或 shell 展开/通配（`* ? < > | $ \` { } ( ) [ ] ! ~`）的目标一律判为 S4。
11. **范围结果**：单个已登记根内 → S1（并给出 `projectIdentifier`）；多个根匹配或声明触及多根 → S2；
    不在任何登记根内 → S3；安装类 → S5；外部软件控制 → S6；远端发布/备份删除 → S7；
    范围类固定为 `S1..S7` 七态，不做"猜测边界"的中间态。
12. **裁决者矩阵实现**：`decideScopeAuthorization` 输出 `allow | ask-superior | ask-user | deny` 与
    `adjudicator`（本地只读策略/上级/认证用户/专用流程）。**deny 优先**；
    思索模式只读放行、其余拒绝；协同 S1 由上级（可配置自动批准并留回执）、S2/S3/S4/S6 需认证用户；
    S5 关闭开关即拒绝；S7 保持专用流程；放权默认按配置，但 **S4 必须上级裁决，不得把用户离线当同意**。
13. **批准回执**：`ScopeApprovalReceipt` 绑定 `scopeClass` + `operationFingerprint`（操作类型/范围/项目/真实目标路径的 SHA-256）
    + `authorizationRevision` + 有效期 + 批准者（上级 `agentInstanceId` 或认证用户）。
    `verifyScopeApprovalReceipt` 返回 `valid | scope-mismatch | fingerprint-mismatch | stale-revision | expired`。
14. **执行前复检**：`recheckBeforeExecution` 重新解析范围（链接/根可能已变化）并校验回执；
    范围变化即 `scope-mismatch` 失效，必须先重新授权。
15. **升级与回派**：`resolveEscalationTarget` —— S1 沿直属上级（四级→三级、三级→次级），
    其余升至有权处理的次级；`isValidEscalationPath` 要求逐级向上、无重复层级、末级为次级、深度 ≤3。
16. **未接线（AUTH-SCOPE-03）**：本模块尚未接入工具执行前门禁、设置界面与公共入口；
    `WorkspaceBoundary` 当前仍以 `process.cwd()` 为根，接线时必须替换为已登记项目根。

## 非目标（AUTH-SCOPE-02 范围外）

- 不实现通用 shell 的静态副作用预测；不可解析即 S4。
- 不改动既有安装门禁存储格式（只消费其开关状态）。
- 不修改治理文档与既有测试预期（AUTH-SCOPE-03 及之后的统一修订）。
## 补充（AUTH-SCOPE-03 冻结：执行前门禁与公共入口）

17. **执行前门禁**（`packages/core/src/tools/scope-authorization-gate.ts`）：
    Worker 工具端口统一被 `ScopeGatedToolPort` 包裹，在真实工具之前做范围判定与裁决；
    未获授权**不触达内层工具**（零副作用），返回稳定错误码：
    `auth-scope-denied`、`auth-scope-awaiting-user-authorization`、
    `auth-scope-awaiting-superior-approval`、`auth-scope-replay-rejected`、
    `auth-scope-authorization-expired`。
18. **工具 → 操作映射**：`createProjectFile`/`replaceFileContent`/`writeFileTemporary` → 项目内写入；
    `readFile`/`listDirectory`/`searchProjectText`/`gitReadonlyView` → 只读；
    `backupVault`/`deleteBackup` → S7 专用流程；其余工具不受本门禁约束；
    参数不可解析或目标含 shell 展开 → 未知范围（S4）。
19. **单次授权与重放保护**：认证用户授权的范围授权**单次使用**（消费时间落记录）；
    同一操作指纹再次执行返回 `auth-scope-replay-rejected`，内层工具不被调用；过期授权返回
    `auth-scope-authorization-expired`。
20. **默认上级批准端口**：运行时缺省把"本地控制面"当作有权上级，**只自动批准 S1（项目内）**，
    其余范围不自动批准（未知/跨根/项目外/安装必须人工）。
21. **登记工程根**：`createApplicationRuntime({ workspaceRootPath, projectIdentifier })` 显式登记工程根；
    `WorkspaceBoundary` 与范围判定都使用该根，**不再隐式读取 `process.cwd()`**（缺省值仍为创建时 cwd，但已是显式登记）。
22. **公共入口**：`listRegisteredProjectRoots`、`evaluateOperationScope`（只读预演，不消费授权）、
    `grantScopeAuthorization`（单次授权）、`queryScopeAuthorizations`（含消费时间的审计视图）。
23. **未完成（诚实声明）**：治理文档与既有测试预期的统一修订、CLI/TUI 设置界面、跨进程（CLI/独立反馈进程）
    的实时授权交互、外部软件控制工具仍属后续增量；本检查点只完成运行时门禁与公共 SDK 入口。

## 非目标（AUTH-SCOPE-03 范围外）

- 不新增通用 shell 或外部软件能力；不实现完美副作用预测。
- 不改写既有安装门禁存储格式与专用授权流程。
- 不修改 AGENTS.md/实施计划等治理文档（由集成者在安全检查点统一修订）。

## 补充（GOV-02b：安装类范围细分与门禁分流）

24. **安装类范围细分**：`dependency-install` 默认仍为 S5；仅当携带**本地生成**的安装范围证据
    （`isProjectInternalControlled=true`、`controlledRootPath` 经 realpath 落在已登记项目根内、且
    `hasGlobalOrExternalEffects` 与 `hasUnknownInstallScripts` 均非 true）时才判为 **S1 子类（项目内受控安装）**。
    **不采信模型自述**；证据缺失或不完整一律 S5（fail-closed）。
25. **分流裁决**：S1 受控安装在协同模式按已配置决策 → `allow`（adjudicator=superior-agent）或 `ask-superior`；
    S5 未受控安装在协同模式仍 `ask-user`；放权模式按已配置 `ask`/`allow` 路由，未知范围仍上级裁决。
26. **开关始终优先**：任何安装类操作（含 S1 受控）在独立安装开关关闭时一律 `deny`，
    且 `requiresInstallationSwitch=true` 由决策、授权记录与执行前复检共同保持；开关不得被自动批准替代。
27. **保留要素不变**：已有资源询问、精确内容与参数绑定、一次性 nonce、revision 与执行前复检、
    `deny` 优先；S4 不得按"用户离线=同意"。
28. **公共入口验证**：`ScopeAuthorizationGate` 把操作类型传入矩阵；端到端覆盖受控安装按上级批准并留回执、
    开关关闭拒绝且不发放授权、未受控安装仍等待认证用户。
29. **未完成（诚实声明）**：`PLAN_STATUS.md` 等用户并行脏文件中的旧表述、旧安装门禁测试期望的统一修订仍属后续；
    安装脚本的完整静态分析/完美副作用预测不在本模块承诺范围内（无法证明受控即归 S4/S5）。

## 补充（GOV-02c：工具 → 操作映射显式化）

30. **无隐式未受门禁的内置工具**：全部内置工具必须显式映射到操作类型，或进入显式的"本地只读、无路径"白名单
    （当前为 `factVerification`、`taskSequenceStatus`）。未映射工具不进入范围门禁，但**未注册/禁用工具由注册表层
    fail-closed 拒绝**（`tool-not-found`，见 `tests/core/integration/provider-tool-loop.test.ts`），不会因此放行。
31. **未来安装/外部软件/进程执行工具**：必须显式映射到 `dependency-install`/`external-software-control`/
    `process-execution`，并提供**本地生成**的范围证据；不得沿用"未映射即放行"。安装类仍受独立开关与参数绑定约束
    （GOV-02b 补充 §24–29）。
32. **当前可达性（审计结论）**：内置工具面不含安装/进程执行工具，因此 `dependency-install`/
    `process-execution`/`external-software-control` 与旧 `InstallationGateGuard` 在当前产品面**无实际可达执行路径**；
    安装规则在门禁层（GOV-02b）与单元层（ADR-0019 安全要素）保持可测，待引入对应工具或桥接工具时按 §31 接线。
