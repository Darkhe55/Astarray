# SMART-01-04 真实运行验收：u2-flash 在途持续接收（2026-10-10）

> 本文件是 SMART-01-04 长期缺失的"**真实运行整机实测**"证据。
> 在此之前的会话里，该卡只能标为"离线部分已证、真实运行未执行（无额度）"。
> **本次取得真实 Provider 额度后一次性通过。**

## 0. 环境与命令

| 项 | 值 |
| --- | --- |
| Provider | 云之声 Unisound（MaaS） |
| 模型 | `u2-flash`（真实慢模型，单次调用约 4.6–5 s） |
| 协议 | `anthropic-messages` |
| 端点 | `https://maas-api.unisound.com/anthropic/v1/messages` |
| 凭据来源 | `--credential-source state`（**仓库既有**的受保护凭据文件条目 `prov-unisound-1`） |
| 命令 | `node scripts/verify-u2-flash-continuous-reception.mjs` |

**凭据纪律**：本次**未读取、未打印、未落盘**任何密钥。脚本自行从受保护凭据文件取用，
并且**判据 ⑧ 专门断言该文件运行前后 sha256 一致**（实测"一致"）。

## 1. 结果：**通过 8/8，退出码 0**

| # | 判据 | 实测值 |
| --- | --- | --- |
| ① | 长只读任务在 180 秒内被受理并派发 | 派发耗时 **18 ms** |
| ② | 任务 A 提交后处于**在途**（尚未完成） | 状态 `running` |
| ③ | **在途期间仍能接收新指令** | 接收耗时 **13 ms**（未超 180 秒） |
| ④ | 派发状态与成果完成**可区分**（派发 ≠ 完成） | 提交时 `accepted`，终态 `done` |
| ⑤ | 两条指令均收敛到终态（关闭回收） | A=`done`，B=`done` |
| ⑥ | 真实运行确实产出了成果（至少一条 done） | done 条数 = 2 |
| ⑦ | 两条指令都产出成果（并行下均成功） | A=`done`，B=`done` |
| ⑧ | 实测**未写入**受保护凭据（字节一致） | 一致 |

判据原文落盘于 `.tmp/live-u2-flash/acceptance-verdict.json`
（`isPassed: true`、`failedCheckNames: []`、`sessionIdentifier`
`live-u2-flash-smart04-1791706691368`）。

**卡内要求逐条对应**：卡内 SMART-01-04 写的是"模拟慢模型/长下级任务仍能接收新指令；
180 秒内派发或如实超时/待澄清；关闭回收，**UI 状态不冒充成果完成**"——
①②③ 对应"在途仍能接收"，④⑥⑦ 对应"不冒充成果完成"，⑤ 对应"关闭回收"。
**本次为真实模型调用，不是注入延迟。**

## 2. 附带发现（如实记录，未修）

`--probe-only`（单次便宜连通检查）在 **Windows + Node v24.18.0** 上
**连通检查通过但进程以 `0xC0000409` 异常结束**，stderr 为：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

- **可复现性**：3/3 次复现；用 `Start-Process -RedirectStandardOutput`
  （不经过 PowerShell 管道）同样复现 ⇒ **不是 EPIPE/管道捕获问题**。
- **影响**：探针模式打印的数据是**完整正确**的（`http-status: 200`、
  `stop-reason: end_turn`、`usage {input_tokens:110, output_tokens:7}`、
  `text-preview: 可用`、`连通验证通过`），只是**退出路径**崩溃。
- **全量模式不受影响**：完整实测 **exit 0**（该模式以 `process.exit(0)` 正常收口）。
- **判断**：属 Windows 专有的 Node/libuv 退出竞态（`process.exit` 时仍有在途 socket），
  **不是本仓验证逻辑的正确性问题**；与卡内"CLI 结果后进程滞留"疑似同类。
- **处理**：本会话**未改**该退出路径（改动编译产物验收脚本的风险大于收益），
  如实登记于此。若要消除，建议在探针模式收敛为显式
  `process.exitCode = …` 并等待 socket 关闭，或升级/规避 Node 版本。

## 3. 对卡状态的影响

- **SMART-01-04**：真实运行项**已取得证据** ⇒ 该检查点在本地可证 + 真实运行范围内
  **可判完成**（其余入口/包级判据此前已交付）。
- **RELIABILITY-01 故障矩阵**：`smart01-continuous-reception-real-run`
  由 `not-verified` 改判为 `confirmed`（证据即本文件与上述脚本）。
- **TOOLKIT-01-06**：真实 token 消耗目前仍**未测**（本轮未对其做计量采集）；
  额度充足不改变"未采集即未测"的口径，故**不因本次实测而改判**。
