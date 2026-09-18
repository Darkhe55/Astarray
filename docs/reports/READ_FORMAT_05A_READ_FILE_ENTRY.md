# READ-FORMAT-05a readFile 视图产品入口与视图感知时间锁 — 证据

> 检查点：READ-FORMAT-05a（READ-FORMAT-05 的产品入口/缓存子检查点）
> 前驱：READ-FORMAT-04b（提交 38a78a2、a84c075，已推送）。日期：2026-09-17
> 契约：docs/adr/0042-read-format-strategy-and-receipt.md（§17 实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| packages/core/src/tools/builtins.ts | readFile 接受 shouldIncludeComments/shouldIncludeImports（缺省 true）；完整原文敏感检查后才生成视图；过滤/不支持/解析失败时前置公共回执行；视图参数参与时间锁键 |
| packages/core/src/tools/read-suppression-ledger.ts | 新增 buildReadViewParameterHash（范围+视图参数+策略版本，不含路径）；账本键纳入参数哈希（同一视图同键、不同视图不同键）；默认参数哈希改为路径无关 |
| tests/core/integration/read-file-view.test.ts（新，7 用例） | 默认原文、回执、unsupported、补读、重复抑制、跨 Agent 隔离、非法参数 |

## 2. 行为反例（先红后绿）

| 反例 | 期望 | 实测 |
| --- | --- | --- |
| 默认参数 | 逐字节原文（兼容既有行为） | 通过：输出等于源文件、无回执前缀 |
| 过滤视图被静默返回 | 前置回执行（status/strategy/省略范围/局限） | 通过：status=filtered、字符串里的 // 保留、注释省略 |
| 未支持格式谎称已过滤 | status=unsupported + 原文 | 通过：format-unsupported 局限可见 |
| 过滤后无法补读全文 | 不同视图不同键，可补读 | 通过：过滤读后全文读取成功 |
| 同视图重复读取绕过时间锁 | 抑制 | 通过：resource-already-read |
| 切换视图刷新同一视图窗口 | 不刷新 | 通过：相同视图参数仍命中同一键 |
| 跨 Agent 误伤 | 各自可读 | 通过：agent-b 读同一视图成功 |
| 非法视图参数被当默认 | 报错 | 通过：必须为布尔值 |
| 路径别名/大小写绕过时间锁（既有回归） | 仍抑制 | 通过：参数哈希路径无关 + 账本规范身份 |
## 3. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npx vitest run tests/core/integration/read-file-view.test.ts tests/core/unit/builtins.test.ts tests/core/unit/read-suppression-and-guard.test.ts --maxWorkers=4 | 0；45 passed（7 新 + 38 回归） |
| npx tsc --noEmit / npx eslint . | 0 / 0 |

## 4. 设计边界

- 敏感内容检查（路径禁用 + 完整原文 DLP）始终先于视图生成；被拒绝时不生成视图、不登记指纹。
- 视图参数哈希不含路径：资源身份由账本键的规范身份（realpath + 大小写折叠）负责，路径别名/大小写不能绕过。
- 内容指纹始终基于完整原文：切换视图不会刷新同一视图的抑制窗口。
- 工作集预算按规范文件身份计数（不同视图仍是同一文件一个槽）——沿用 ADR-0029 既有实现，本检查点未改。
- tarball 隔离安装离线可用与资源测量属 **READ-FORMAT-05b**。

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：220 文件 / 1783 用例全通过（+1 文件 / +7 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 93.01 / 85.12 / 92.97 / 93.04；builtins 87.67 / 80.37 / 100 / 87.58；read-suppression-ledger 95.45 / 100 / 92.30 / 95.34 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | **exit 0**（第 1 次尝试成功）：a84c075..b0b3d38 已推送 |

本检查点实现提交：`b0b3d38`（feat(read-format): READ-FORMAT-05a readFile 视图产品入口与视图感知时间锁）。

## 6. 未满足项与后续

- **READ-FORMAT-05b**：tarball 隔离安装离线可用、资源测量（解析耗时/峰值内存/返回量）、补读与跨 Agent 隔离的包级验证。
- GUIDE 增量（用户文档 §6）在相关契约确定后接入；**READ-FORMAT-05 全卡收口后 READ-FORMAT 卡全部完成**。
- 治理文档统一修订未开始。

