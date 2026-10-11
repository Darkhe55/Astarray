/**
 * 权限询问等待（从 `run-command.ts` 提取，2026-10-10）。
 *
 * **为什么提取**：该函数原为 `run-command.ts` 内的**未导出**函数，因此只能通过
 * 真实 CLI 子进程间接覆盖（v8 看不见子进程），导致它所包含的**两处修复语义长期零覆盖**：
 *
 *  1. **已消费的升级文本不得重复触发询问**（`startIndex` 切片）；
 *  2. `allow-once` 之后任务会短暂回到 `running`，此期间**不得立即收口**，
 *     必须给"授权后重跑"一个窗口（`advancementWindowMilliseconds`），
 *     否则 CLI 会在工具真正执行之前收口（**正向闭环失败**）。
 *
 * 这两条都是**产品行为修复**，值得被直接、确定性地测试（而不是靠子进程 + 真实计时）。
 * 提取后 `run-command.ts` 从本模块导入同一实现，**语义完全不变**。
 *
 * 本模块不产生副作用：只做"读状态 + 决定何时返回"，不写盘、不联网。
 */

import { buildPermissionAskFromEscalation } from "./permission-ask-adjudication.js";

/** 轮询间隔（毫秒）：等待新询问/终态时的静默间隔。 */
const PERMISSION_ASK_POLL_INTERVAL_MILLISECONDS = 25;

/**
 * 等待本轮的 permission-ask 升级文本到达。
 *
 * @param escalationMessages 本次任务累计的升级文本（含**已消费**的历史）。
 * @param timeoutMilliseconds 总等待上限。
 * @param queryTask 查询任务状态（只读）。
 * @param startIndex 只看从该下标起的**尚未裁决**文本（已消费的不得重复触发）。
 * @param isTerminalFailure 任务是否已**终态失败**（例如门禁判失败）⇒ 不会再有裁决需求。
 * @param advancementWindowMilliseconds 任务重新推进（running）时仍继续等待的窗口。
 */
export async function waitForPermissionAsk(
  escalationMessages: string[],
  timeoutMilliseconds: number,
  queryTask: () => Promise<{ status: string }>,
  startIndex = 0,
  isTerminalFailure: () => boolean = () => false,
  advancementWindowMilliseconds = 0,
): Promise<ReturnType<typeof buildPermissionAskFromEscalation>> {
  const deadline = Date.now() + timeoutMilliseconds;
  let advancementWindowDeadline: number | null =
    advancementWindowMilliseconds > 0 ? Date.now() + advancementWindowMilliseconds : null;
  while (Date.now() < deadline) {
    // 任务已**终态失败**（例如门禁判失败）：不会再有裁决需求，立即返回。
    if (isTerminalFailure()) {
      return null;
    }
    // 只看**尚未裁决**的升级文本（已消费的不得重复触发询问）。
    const pendingEscalations = escalationMessages.slice(startIndex);
    const permissionAsk = pendingEscalations
      .map((escalationText) => buildPermissionAskFromEscalation(escalationText))
      .find((ask) => ask !== null);
    if (permissionAsk !== undefined) {
      return permissionAsk;
    }
    // 任务已不是 blocked（完成/失败/取消）时无需再等待裁决。
    const currentStatus = (await queryTask()).status;
    if (currentStatus !== "blocked") {
      // 处于推进窗口内：继续等新询问（不立即收口）。
      if (
        advancementWindowDeadline !== null &&
        Date.now() < advancementWindowDeadline
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, PERMISSION_ASK_POLL_INTERVAL_MILLISECONDS),
        );
        continue;
      }
      return null;
    }
    // 一旦回到 blocked，推进窗口结束。
    advancementWindowDeadline = null;
    // blocked 且**已收到非询问类升级**（例如门禁判失败）→ 不会再有裁决需求，立即返回。
    if (
      pendingEscalations.length > 0 &&
      pendingEscalations.every(
        (escalationText) => buildPermissionAskFromEscalation(escalationText) === null,
      )
    ) {
      return null;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, PERMISSION_ASK_POLL_INTERVAL_MILLISECONDS),
    );
  }
  return null;
}
