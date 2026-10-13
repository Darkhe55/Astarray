/**
 * 「recover abandon 误报成功」反例（2026-10-12）。
 *
 * **被测性质**：对**不存在**的 mission 调用 `abandonMission` 时，
 * `abandoned` **必须为 `false`** —— 不得把"什么都没做"报成"已放弃"。
 *
 * **背景（已核实的根因链条）**：
 * - `MissionManager.updateMissionStatus`：mission 不存在时**静默 return**（不报错）；
 * - `MissionManager.probeMissionDirectory`：如实返回 `exists: false` / `summaryStatus: null`；
 * - 但 `RecoveryCenterController.abandonMission` **无条件**填 `abandoned: true`
 *   ⇒ 对不存在的 mission 也报"已放弃"。
 *
 * `RecoveryAbandonResult.abandoned` 本就是**布尔**，语义即"是否真的放弃了"，
 * 故修复方向是**如实填 `false`**（而非改退出码——`recover abandon` 的
 * "幂等 ⇒ 退出码 0"是既有约定，见 `commands.ts` 的无条件 `return EXIT_CODES.SUCCESS`）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecoveryCenterController } from "../../../packages/core/src/orchestration/recovery-center-controller.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-abandon-honest-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("recover abandon 必须如实报告", () => {
  it("① 对**不存在**的 mission ⇒ `abandoned` 必须为 false（不得误报成功）", async () => {
    const controller = new RecoveryCenterController({ baseDirectory: stateDirectory });
    const result = await controller.abandonMission("mission-does-not-exist");

    expect(
      result.abandoned,
      "不存在的 mission 没有被放弃，`abandoned` 必须是 false；" +
        "报 true 会让用户以为已经关停了某个 mission",
    ).toBe(false);
    expect(result.statusAfter).toBeNull();
    expect(result.artifactsRetained).toBe(true);
  });
});