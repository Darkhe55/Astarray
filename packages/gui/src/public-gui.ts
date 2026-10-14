/**
 * GUI 公开入口（GUI-02-04，2026-11-08）。
 *
 * ## 为什么需要它
 *
 * 卡内 GUI-02-04 要求「**隔离 tarball 打开 GUI 复验**」。但实测：`tsup.config.ts` 的 entry
 * 原本只有 `cli`／`feedback-process-entry`／`public-sdk` ⇒ `packages/gui` 的代码只被
 * 打进一个**内部 chunk**、**没有公开入口、也不在 `package.json` 的 `exports` 里**。
 * 后果是：**消费者装上 tarball 也拿不到 GUI**，"打开 GUI"无从谈起。
 *
 * 本文件即 GUI 的**公开面**：只导出"启动本地 GUI 宿主"与它的公开类型，
 * 不把内部实现细节（读模型内部函数、路由表等）暴露出去。
 *
 * ## 边界（与 GUI-01-R-02 冻结一致）
 *
 * - 只监听 **loopback**；校验规范化 Host/Origin 与会话 CSRF（SameSite=Strict）；
 * - 只提供脱敏 JSON 与转义后的 HTML；**不提供通用文件读取 API**；
 * - 状态变更一律经**公共应用服务**（`applicationService`），前端不复制任何规则。
 */
export { startGuiServer, type GuiApplicationPort } from "./server/gui-server.js";
export type {
  GuiMissionHistoryEntryView,
  GuiMissionHistoryPageView,
} from "./server/gui-server.js";

