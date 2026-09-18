# READ-FORMAT-05b 安装包离线可用与资源测量 — 证据

> 检查点：READ-FORMAT-05b（READ-FORMAT-05 的打包/测量子检查点，收口 READ-FORMAT 全卡）
> 前驱：READ-FORMAT-05a（提交 b0b3d38、41704b4，已推送）。日期：2026-09-17
> 契约：docs/adr/0042-read-format-strategy-and-receipt.md（§18 实现记录）

## 1. 交付物

| 文件 | 内容 |
| --- | --- |
| scripts/verify-read-format-package.mjs（新） | 从**隔离安装**的包目录导入公共 SDK，校验读取策略行为、回执字段与资源测量（耗时/峰值堆/返回量），无网络依赖 |
| packages/core/src/public-sdk.ts | 导出 `ReadFormatStrategyRegistry`/`defaultReadFormatStrategyRegistry`/`DEFAULT_READ_FORMAT_STRATEGIES` 与相关类型，供安装包消费者与包级校验使用 |
| tests/core/unit/read-format-resource-metrics.test.ts（新，1 用例） | 26 个真实夹具 × 4 参数组合 × 20 轮：回执不变量、视图不长于原文、耗时/内存有界，并打印测量 JSON |
| package.json | 新增 `verify:read-format-package` 脚本 |

## 2. 校验内容与结果

| 检查 | 期望 | 实测 |
| --- | --- | --- |
| tarball 离线安装（npm install --offline --ignore-scripts） | 成功且无网络 | 通过：added 41 packages in 10s，`--offline` |
| 安装包公共 SDK 导入 | 成功 | 通过：默认策略注册表可用 |
| C 注释过滤 | 注释省略、字符串/宏保留 | 通过：filtered/partially-filtered、`"// not a comment"` 与 `#define` 保留 |
| include 省略 | 按需省略 | 通过 |
| Python 文档字符串 | 保留 | 通过 |
| Rust 嵌套块注释 / 原始字符串 | 省略 / 保留 | 通过 |
| 未支持格式 | status=unsupported + 原文 | 通过 |
| 未闭合源码 | parse-error + 原文 | 通过 |
| 回执字段 | sourceHash(64)/sensitiveCheckAppliedBeforeView/budgetImpact/measuredUnits | 通过 |
| tarball 内容校验（scripts/verify-package.mjs） | 无敏感文件、shebang/BOM 正确 | 通过：213 个文件 |
## 3. 测量结果（本机 win32 / Node v24.18.0）

| 场景 | 输入 | 视图数 | 总耗时 | 平均/视图 | 峰值堆增量 | 返回量 |
| --- | --- | --- | --- | --- | --- | --- |
| 源级全夹具（26 夹具 × 4 组合 × 20 轮） | 117,200 B/轮 | 2080 | 354 ms | 0.1702 ms | 22,631,480 B | 401,340 B（≤ 输入×4） |
| 安装包 5 夹具 × 200 轮 | 355 B/轮 | 1000 | 15 ms | 0.015 ms | 6,348,824 B | 57,792 B |

说明：阈值为宽松上限（总耗时 < 30s、平均 < 20ms/视图、峰值堆 < 128MB），仅用于捕捉数量级回归；
不承诺磁盘 I/O 减少（ADR-0042 §8）。

## 4. 命令与退出码

| 命令 | 结果 |
| --- | --- |
| npm run build | 0 |
| npm pack --ignore-scripts --pack-destination <tmp> | 0；astarray-0.1.0.tgz |
| npm install --offline --ignore-scripts --no-audit --no-fund <tgz>（隔离目录） | 0；added 41 packages |
| node scripts/verify-read-format-package.mjs --package-dir <安装目录>/node_modules/astarray | 0；status=ok |
| node scripts/verify-package.mjs <tgz> | 0；213 个文件 |
| npx vitest run tests/core/unit/read-format-resource-metrics.test.ts --maxWorkers=4 | 0；1 passed |

## 5. 门禁与推送

| 命令 | 结果 |
| --- | --- |
| npm run typecheck / npx eslint . / npm run build | 0 / 0 / 0 |
| npx vitest run --maxWorkers=6 | exit 0：221 文件 / 1784 用例全通过（+1 文件 / +1 用例） |
| npx vitest run --coverage --maxWorkers=6 | exit 0：全局 93.01 / 85.14 / 92.97 / 93.04；tools/read-format 92.29 / 85.03 / 98.80 / 92.21 |
| npm run verify:security-coverage | exit 0：关键安全模块 22/22 达标（阈值 95%） |
| git push | 见提交记录 |

## 6. 未满足项与后续

- **READ-FORMAT-01..05 全卡完成**（含 01 冻结、02 三族、03a/03b 前端与混合、04a/04b LaTeX/配置/其他语言、05a/05b 入口与打包测量）。
- 未验证：真实项目大规模源码（>10MB/数万行）吞吐与内存；本测量基于仓库夹具与合成重复调用。
- 后续：GUIDE 增量（用户文档 §6）、WB-00 剩余检查点、E2E-01/GUI-01-R/BRIDGE-01 外部依赖项，以及**治理文档统一修订**（正式启用前必须完成）。

