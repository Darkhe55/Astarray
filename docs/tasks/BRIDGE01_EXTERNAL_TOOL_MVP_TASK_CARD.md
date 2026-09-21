# BRIDGE-01：外部工具接入 MVP

> 状态：in_progress（BRIDGE-01-01/02/03 done；-04 待真实客户端）
> 创建日期：2026-09-10
> 类型：后续扩展；高风险工作按检查点执行
> 来源：用户授权布置；本文件为Agent派生实施方案，运行态节点默认层级1或以下，不冒充用户层级0
> 前驱：T07D-R1；发布验收依赖E2E-01

## 执行契约

必须先读取 [本批实施顺序与共同验收规则](./PRODUCT_INTEGRATION_ROLLOUT.md) 及 AGENTS.md 指定的四份治理文档。该共同文件是本卡的一部分，包含批次、测试、证据、安装、Git及停止条件。原任务卡的未满足验收要求继续有效。

## 目标与范围

优先准备MCP工具接入候选，首个检查点确定目标客户端和一种传输；通过同一公共应用服务接入，禁止同时实施MCP/A2A/通用HTTP三套协议。

## 检查点

### BRIDGE-01-01：目标与协议冻结

- 状态：done（2026-09-12；决策 docs/adr/0032-external-tool-bridge-mcp-stdio.md，证据 docs/reports/BRIDGE01_01_PROTOCOL_FREEZE.md）。
- 工作：确认目标宿主已有接入能力，读取所选协议官方当前规范；记录具体版本、传输、认证、取消及异步结果语义ADR。
- 验收：选择一种协议及一个目标客户端；列出兼容矩阵，未实现协议不声明支持；如MCP不匹配目标则在编码前调整该卡。
- 前驱：本卡前驱。先通过前驱，再执行本节点。

### BRIDGE-01-02：最小工具映射

- 状态：done（2026-09-12；证据 docs/reports/BRIDGE01_02_TOOL_MAPPING_EVIDENCE.md）。
- 工作：提供submit/query/cancel/read-result最小工具面，绑定认证主体、任务ID、来源及幂等键；复用应用服务。
- 验收：接受回执不误报完成；外部Agent不能冒充用户优先级0；字符串user前缀或schema通过不构成认证。
- 前驱：BRIDGE-01-01。先通过前驱，再执行本节点。

### BRIDGE-01-03：边界与断连

- 状态：done（2026-09-12；证据 docs/reports/BRIDGE01_03_BOUNDARIES_EVIDENCE.md）。
- 工作：覆盖会话隔离、逐次权限、结果脱敏、断连重试、取消和服务关闭；协议层不直接执行底层写工具。
- 验收：跨主体访问拒绝；重放不重复任务；输出注入、秘密回显和取消后续写反例通过。
- 前驱：BRIDGE-01-02。先通过前驱，再执行本节点。

### BRIDGE-01-04：真实客户端消费

- 状态：in_progress（脚本化 stdio 闭环已在 tarball 安装产物上 13/13 通过；第三方客户端消费待用户授权）。
- 工作：从tarball启动桥接，目标客户端提交任务、查询结果并取消另一任务。
- 验收：真实客户端完整闭环证据；协议失败与业务失败可区分；对外支持声明绑定版本和平台。
- 前驱：BRIDGE-01-03。先通过前驱，再执行本节点。

## 注意事项

没有HTTP server不等于没有MCP。是否需要常驻进程、联网监听和认证必须按实际传输冻结，不能依据名称推断。

每轮仅一个检查点；实现、测试、文档与状态证据一起交付。若需要超过三小时，在可构建边界继续拆分。本卡done要求所有必选检查点通过；缺真实服务、人工或平台证据时按明确范围保留blocked/pending，不用说明文字覆盖未满足门禁。

## 验收记录

- 当前提交/工作树基线：`d2c85bc`（E2E-01-04 本地可证项收口）。用户并行改动（IMPLEMENTATION_PLAN.md、PLAN_STATUS.md、docs/tasks/README.md 及 3 张未跟踪卡）保持未暂存。
- 本检查点实现与入口证据：BRIDGE-01-01 冻结记录 docs/adr/0032-external-tool-bridge-mcp-stdio.md（协议/传输/认证/取消/异步语义/工具面/兼容矩阵）与 docs/reports/BRIDGE01_01_PROTOCOL_FREEZE.md；BRIDGE-01-02 工具映射 docs/reports/BRIDGE01_02_TOOL_MAPPING_EVIDENCE.md（桥接规则、stdio 会话、公共入口 `astarray mcp serve`、验收对照与覆盖率）。
- 测试命令、退出码和产物哈希：BRIDGE-01-03：`npm run check` exit 0（180 文件/1531 用例）、`npm run test:coverage` exit 0（全局 branch 86.52%；`core/src/bridge` 98.96% stmts/86.89% branch/100% funcs/98.95% lines）；BRIDGE-01-02：check 180/1528、branch 86.54%、bridge 目录 100% stmts/funcs/lines；BRIDGE-01-01 为决策检查点（无代码变更）。
- 人工/外部依赖及剩余风险：BRIDGE-01-04 的真实 MCP 客户端属待确认依赖（按协同安装门禁先询问用户，不隐式下载）；Linux/macOS 平台未验证；Streamable HTTP/A2A/通用 HTTP 明确不在本批范围。
- 本地提交、推送尝试与结果：BRIDGE-01-01 `175d40b`、补记 `ca8acba`；BRIDGE-01-02 `b652109`、补记 `401196f`；BRIDGE-01-03 `8289b00`（`git push` 第 1 次成功，`364c3b4..8289b00`）。
- BRIDGE-01-04 脚本化 stdio 闭环（2026-09-19，in_progress）：新增 `scripts/verify-mcp-bridge-loop.mjs`（真实 stdio MCP 客户端，换行分隔 JSON-RPC；按路径调用，未加 npm 别名以免改变已记录 tarball 字节）；对**隔离安装产物**的 `dist/cli.js` 启动 `mcp serve` 执行 **2 场景 / 20 项断言**全部通过（场景 1：协议协商 2026-07-28、四个工具面、受理回执≠完成、幂等重放、`read_result` 不伪造、取消、业务失败 `isError=true` 与协议失败 `-32700/-32601` 可区分、禁止本地写/执行工具被拒、stdout 仅 MCP 消息；场景 2：同一状态目录下主体 A/B 隔离——B 读取/取消 A 的任务一律 `task-not-accessible`，B 自己的任务可继续用，A 断连后进程自行退出且未走 SIGKILL），exit 0。证据 docs/reports/BRIDGE01_04_STDIO_CLOSED_LOOP_EVIDENCE_2026-09-19.md。
- BRIDGE-01-04 剩余范围：第三方客户端（`opencode`/`pi`，本机已装）消费与模型驱动闭环需用户授权与 Provider 凭据；Linux/macOS 平台未验证。

## 首轮执行指令

读取共同实施规则与本卡，核对前驱动态证据。本轮只执行 BRIDGE-01-01；先记录基线和失败场景，再完成该检查点。不要领取后继，未满足条件不得标记done。

