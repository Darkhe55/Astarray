/**
 * 可信宿主用户上下文（检查点 B）。
 * 本地 CLI/GUI 的授权主体来自操作系统登录用户；SDK 嵌入方应显式提供认证用户标识。
 * 解析不到时返回 null——调用方必须 fail-closed，禁止伪造固定身份。
 */
import os from "node:os";

export function resolveHostUserIdentifier(): string | null {
  try {
    const userInfo = os.userInfo();
    const username = typeof userInfo.username === "string" ? userInfo.username.trim() : "";
    return username.length > 0 ? username : null;
  } catch {
    return null;
  }
}
