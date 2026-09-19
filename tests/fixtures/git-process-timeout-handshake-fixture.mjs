/**
 * LINUX-PORT-01 超时夹具：可握手、可回收的常驻 Node 子进程。
 * 用法：node git-process-timeout-handshake-fixture.mjs <handshakeFilePath>
 * 启动后把自身 pid 写入握手文件（调用方据此确认进程已真正存活），随后常驻等待，
 * 直到被 SIGKILL 回收；不依赖 git 启动计时，避免平台计时脆弱。
 */
import { writeFileSync } from "node:fs";

const handshakeFilePath = process.argv[2];
if (typeof handshakeFilePath !== "string" || handshakeFilePath === "") {
  process.stderr.write("缺少握手文件路径\n");
  process.exit(2);
}

writeFileSync(handshakeFilePath, `${process.pid}\n`, "utf8");
setInterval(() => {}, 1_000);
