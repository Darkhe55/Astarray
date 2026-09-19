# Linux 验收环境侦察记录（本机 WSL 非用户测试机）

> 日期：2026-09-19
> 执行：DSH 主 Agent 会话（Windows 工作区 `C:\Users\MerchRev\Documents\astarray`）
> 结论摘要：本机 WSL 发行版**不是**用户用于 Linux 人工体验的机器，不能作为该机器的平台证据来源。
> 用户 Linux 机的 `sh: 1: tsc: Permission denied` 根因已定位为「Windows 安装树被拷贝」。
> 平台状态不变：Linux 仍为**未验证**（见 `docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md` §2）。

## 1. 触发原因

用户在 Linux 侧执行 `npm run check` / `npm pack` 报：

```
sh: 1: tsc: Permission denied
npm error code 127
npm error path /home/ubuntu/astarray
```

为判断能否由本会话直接在本机 WSL 复现并取证，做了两步只读侦察。

## 2. 沙箱可达性观察（Windows 侧）

| 探测 | workspace-write（默认） | danger-full-access（一次性提权） |
| --- | --- | --- |
| `wsl.exe -l -v` / `wsl.exe --status` | `Wsl/EnumerateDistros/Service/E_ACCESSDENIED` | 正常返回 |
| `Test-Path '\\wsl$\Ubuntu'` | Access denied | True |
| `wsl.exe -d Ubuntu -- uname -a` | `Wsl/Service/E_ACCESSDENIED` | 正常返回 |
| `Get-Service WslService` | Running | Running |

拒绝来自沙箱对 WSL 服务 RPC 与 9P/\`\\wsl$\` 文件通道的限制，**不是** WSL 未安装。后续任何 WSL 操作都必须显式提权；本会话已记录该拒绝，可 upfront 提权。

## 3. 本机 WSL 事实（`wsl -d Ubuntu`）

| 项 | 实测 |
| --- | --- |
| 发行版 | `Ubuntu`（默认，探测时处于 Stopped，被本次调用启动）、`docker-desktop` |
| 发行版版本 | Ubuntu 26.04 LTS |
| 内核 | `6.18.33.2-microsoft-standard-WSL2` x86_64 |
| 默认用户 / HOME | `darkh` / `/home/darkh` |
| `/home/ubuntu` | 不存在 |
| astarray 检出 | 未找到（`find /home /root /srv /opt -maxdepth 3 -name astarray -type d` 无结果） |
| Linux 侧 node | 无：`node: command not found` |
| `which npm npx` | `/mnt/c/Program Files/nodejs/npm`、`/mnt/c/Program Files/nodejs/npx`（Windows 互操作） |
| `npm -v` | 11.16.0（即 Windows 侧 npm） |
| nvm | 不存在（`/home/*/.nvm`、`/root/.nvm` 均无） |
| 其他工具 | `/usr/bin/git`、`/usr/bin/curl` 存在 |
| 网络告警 | `wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理` |

## 4. 与用户测试机对照

| 项 | 用户 Linux 机（回传） | 本机 WSL |
| --- | --- | --- |
| `npm --version` | 10.9.8 | 11.16.0（Windows npm，经互操作） |
| `node -v` | v22.23.2 | 无 node |
| 工作目录 | `/home/ubuntu/astarray` | 无该目录，且无任何 astarray 检出 |
| 判定 | — | **不是同一环境** |

## 5. 用户 Linux 机根因结论（跨环境有效）

回传证据：

- `ls -l node_modules/.bin/tsc` → `-rw-rw-r-- 1 ubuntu ubuntu 385 Aug 12 11:37`（**无 x 位**）
- `findmnt -T . -o TARGET,FSTYPE,OPTIONS` → `/ ext4 rw,relatime`（**无 noexec**）

结论：该 `node_modules` 是 Windows 安装树整体拷贝到 Linux 的结果；执行被拒是缺可执行位，不是挂载 `noexec`。Windows 侧原生二进制（如 `@esbuild/win32-x64`）在 Linux 上不可用，因此正确修法是重装而非 chmod：

```bash
cd /home/ubuntu/astarray
rm -rf node_modules dist
npm ci          # lockfile 不一致时改用 npm install
npm run check
```

若重装后 build 报缺少 `@esbuild/linux-x64`，用 `npm install --include=optional` 补可选依赖。

安装属安装类操作：按 `AGENTS.md` 需独立安装开关已开启并逐次授权；本会话**未**代为执行，也未在任何环境运行该命令。

## 6. 边界与未决

- 本记录**不构成** Linux 平台验收证据；Linux 平台状态仍为「未验证」，不预填任何实测。
- 本机 WSL 未执行任何测试（仅两次只读侦察）。
- 若希望改以本机 WSL 作为 Linux 验证环境，须另开以下安装类事项并逐次取得用户授权：Linux 侧 Node 工具链安装、检出物化（复制或克隆）、`npm ci`、以及网络/代理配置（NAT 模式下 localhost 代理不可用）。
- 用户 Linux 机的 `npm run check` 结果、coverage global 数字、`npm pack` 的 tarball/SHA256 与 `verify-package.mjs`、`smoke-install.mjs` 退出码仍未回传，故 Linux 平台证据段保持空缺。

## 7. 侦察脚本与产物

- `.tmp/linux-evidence/probe.sh`、`.tmp/linux-evidence/probe2.sh`（`.tmp/` 已 gitignore，不入库）
- 命令：`wsl.exe -d Ubuntu -- bash /mnt/c/Users/MerchRev/Documents/astarray/.tmp/linux-evidence/probe2.sh`
