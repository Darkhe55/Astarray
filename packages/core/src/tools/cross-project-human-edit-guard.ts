/**
 * PROJECT-01-03（2026-10-31）：**人工改动守卫**的生产实现。
 *
 * ## 依据（本卡检查点 ②，2026-10-29 复核原文）
 *
 * > "② 人工改动守卫（`CrossProjectTargetHumanEditGuardPort`）同样需要生产实现
 * >   （缺它时目标已存在恒 fail-closed，是安全默认，但等于'能读不能导'）"
 *
 * ## 它要回答的唯一问题
 *
 * 目标**已存在**时：那里的字节是否**仍然等于**本次准备写入的内容（即来源内容）？
 * - 相等 ⇒ **没有**人工改动 ⇒ 允许写入（幂等重放/重复导入）；
 * - 不相等 ⇒ **有**人工改动 ⇒ 服务据此拒绝覆盖（`target-stale-rejected`）。
 *
 * ## 为什么必须 fail-closed
 *
 * 本守卫是"人工字节保护"的最后一道；**读不到**目标内容时**绝不能**回答
 * "没有人工改动"（那等于放行覆盖，可能抹掉用户手改的内容）。
 * 故任何不确定（读失败、目标不是普通文件）都判为**有人工改动**。
 */
import { promises as fs } from "node:fs";

import type { CrossProjectTargetHumanEditGuardPort } from "../orchestration/cross-project-authorization-store.js";

/**
 * 生产实现：**逐字节比较**目标现有内容与预期内容。
 *
 * 判定表：
 * | 目标状态 | 结果 |
 * | --- | --- |
 * | 不存在 | `hasHumanChange: false`（没有人工字节可保护） |
 * | 普通文件且内容**等于**预期 | `false`（幂等复用/重复导入安全） |
 * | 普通文件且内容**不等于**预期 | `true`（人工改过） |
 * | **读失败** / 目标**不是普通文件**（目录等） | `true`（**fail-closed**：不确定即视为有人工改动） |
 */
export function createCrossProjectHumanEditGuard(): CrossProjectTargetHumanEditGuardPort {
  return {
    async hasUnexpectedHumanChange(input: {
      absoluteTargetPath: string;
      expectedContent: string;
    }): Promise<{ hasHumanChange: boolean; reason?: string }> {
      let targetStat;
      try {
        targetStat = await fs.stat(input.absoluteTargetPath);
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === "ENOENT") {
          // 目标不存在：没有任何人工字节可保护。
          return { hasHumanChange: false };
        }
        // 其他 stat 失败（权限等）：**不确定** ⇒ fail-closed。
        return {
          hasHumanChange: true,
          reason:
            "无法确认目标状态（stat 失败: " + String(errorCode ?? "unknown") +
            "）⇒ 按存在人工改动处理（fail-closed）",
        };
      }

      if (!targetStat.isFile()) {
        return {
          hasHumanChange: true,
          reason: "目标已存在但不是普通文件（可能是目录/链接）⇒ 拒绝覆盖（fail-closed）",
        };
      }

      let existingContent: string;
      try {
        existingContent = await fs.readFile(input.absoluteTargetPath, "utf8");
      } catch (error) {
        return {
          hasHumanChange: true,
          reason:
            "无法读取目标现有内容（" + String((error as Error).message) +
            "）⇒ 按存在人工改动处理（fail-closed）",
        };
      }

      if (existingContent === input.expectedContent) {
        // 目标与预期一致（例如上次导入已写成功、只是回执未落地）⇒ 不算人工改动。
        return { hasHumanChange: false };
      }
      return {
        hasHumanChange: true,
        reason:
          "目标现有内容与预期副本不一致（长度 " + String(existingContent.length) +
          " vs " + String(input.expectedContent.length) + " 字符）",
      };
    },
  };
}
