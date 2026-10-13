/**
 * COMM-01-02 反例（2026-10-18）：执行层**唯一上级**归属与按地址投递授权。
 *
 * 卡内缺口原文（COMM-01-01 审计）：
 *  - `unbounded-agent-registry.ts`："**无统一持久化父子归属字段与跨实例唯一性约束**"；
 *  - `quaternary-lifecycle-controller.ts`："尚不能证明所有入口、恢复和转交路径都**强制唯一上级**"。
 *
 * 本片钉住最小但关键的语义（先写反例，模块此时尚不存在 ⇒ 必须先红）：
 *  ① 一个子只能有**一个**上级：两个上级**并发**绑定同一子 ⇒ 只允许一个成功；
 *  ② 非直属上级**不得**作为被授权出口（越级/直联兄弟必须被拒）；
 *  ③ 归属必须**持久化**：重启（新实例）后仍能判定"谁是我的上级"；
 *  ④ 释放后可重新绑定（否则被回收的子会永久不可用）；
 *  ⑤ 上级被回收 ⇒ 其下的绑定**不得**再放行新投递（但历史归属仍可查，供报告追溯）；
 *  ⑥ 伪造来源（自称直属上级）不得放行。
 *
 * 只跑本地逻辑与临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ParentBindingController,
  ParentBindingStore,
} from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";

let stateDirectory: string;

const TERTIARY = "tertiary-agent-1";
const SECONDARY_A = "secondary-agent-a";
const SECONDARY_B = "secondary-agent-b";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-comm01-parent-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("COMM-01-02：执行层唯一上级归属", () => {
  it("① 两个上级并发绑定同一子 ⇒ 只允许一个成功，另一个必须被拒", async () => {
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });

    const first = await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });
    const second = await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_B,
    });

    expect(first.isBound).toBe(true);
    expect(second.isBound).toBe(false);
    // 归属不得被"后到者"顶掉
    await expect(controller.resolveParentOf(TERTIARY)).resolves.toBe(SECONDARY_A);
  });

  it("② 非直属上级不得作为被授权出口（越级 / 直联兄弟 / 伪造来源均拒）", async () => {
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });
    await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });

    // 直属上级 ⇒ 放行
    await expect(
      controller.isDeliveryAllowed({
        childAgentInstanceId: TERTIARY,
        claimedParentAgentInstanceId: SECONDARY_A,
      }),
    ).resolves.toBe(true);

    // 另一个次级（兄弟层/越级）⇒ 拒绝
    await expect(
      controller.isDeliveryAllowed({
        childAgentInstanceId: TERTIARY,
        claimedParentAgentInstanceId: SECONDARY_B,
      }),
    ).resolves.toBe(false);

    // 未绑定的子 ⇒ 拒绝（不得"未绑定即放行"）
    await expect(
      controller.isDeliveryAllowed({
        childAgentInstanceId: "tertiary-agent-unknown",
        claimedParentAgentInstanceId: SECONDARY_A,
      }),
    ).resolves.toBe(false);
  });

  it("③ 归属必须持久化：新实例（模拟重启）仍能判定直属上级", async () => {
    const firstStore = new ParentBindingStore({ stateDirectory });
    const firstController = new ParentBindingController({ store: firstStore });
    await firstController.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });

    // 全新实例读同一状态目录
    const reopenedStore = new ParentBindingStore({ stateDirectory });
    const reopenedController = new ParentBindingController({ store: reopenedStore });
    await expect(reopenedController.resolveParentOf(TERTIARY)).resolves.toBe(SECONDARY_A);
    // 且重启后仍然拒绝非直属上级
    await expect(
      reopenedController.isDeliveryAllowed({
        childAgentInstanceId: TERTIARY,
        claimedParentAgentInstanceId: SECONDARY_B,
      }),
    ).resolves.toBe(false);
  });

  it("④ 释放后可重新绑定（不得让被回收的子永久不可用）", async () => {
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });
    await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });

    const released = await controller.releaseChild({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });
    expect(released.wasReleased).toBe(true);
    await expect(controller.resolveParentOf(TERTIARY)).resolves.toBeNull();

    // 释放后可由另一个上级绑定
    const rebound = await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_B,
    });
    expect(rebound.isBound).toBe(true);
    await expect(controller.resolveParentOf(TERTIARY)).resolves.toBe(SECONDARY_B);
  });

  it("⑤ 上级被回收 ⇒ 不得再放行新投递，但历史归属仍可查（供报告追溯）", async () => {
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });
    await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });

    await controller.markParentRecycled({ parentAgentInstanceId: SECONDARY_A });

    await expect(
      controller.isDeliveryAllowed({
        childAgentInstanceId: TERTIARY,
        claimedParentAgentInstanceId: SECONDARY_A,
      }),
    ).resolves.toBe(false);
    // 历史归属不得被抹掉（否则无法解释"这条报告当初是谁收的"）
    await expect(controller.resolveHistoricalParentOf(TERTIARY)).resolves.toBe(SECONDARY_A);
  });

  it("⑥ 同一上级重复绑定同一子 ⇒ 幂等成功（不得因重试而失败）", async () => {
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });

    const first = await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });
    const retry = await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });

    expect(first.isBound).toBe(true);
    expect(retry.isBound).toBe(true);
    await expect(controller.resolveParentOf(TERTIARY)).resolves.toBe(SECONDARY_A);
  });
});

describe("COMM-01-02：状态文件损坏/版本不符时按空继续（不伪造归属）", () => {
  it("⑦ `schemaVersion` 不符 ⇒ 不得把异版本文档的归属当有效（否则会凭空多出一个上级）", async () => {
    /**
     * 定向反例：`loadFromDisk` 里 `parsed.schemaVersion !== 1` 一路。
     * 语义：**不伪造归属** —— 版本不符一律按空；
     * 否则旧格式里的绑定会被当作当前有效归属，等于**凭空造出一个上级**。
     */
    await fs.writeFile(
      path.join(stateDirectory, "agent-parent-bindings.json"),
      JSON.stringify({
        schemaVersion: 999,
        bindings: [
          {
            childAgentInstanceId: TERTIARY,
            parentAgentInstanceId: SECONDARY_B,
            boundAtIso: "2026-10-01T00:00:00.000Z",
            releasedAtIso: null,
            parentRecycledAtIso: null,
          },
        ],
        recycledParents: [],
      }),
      "utf8",
    );

    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });

    await expect(controller.resolveParentOf(TERTIARY)).resolves.toBeNull();
    // 异版本里的"上级"不得被认作可投递出口
    await expect(
      controller.isDeliveryAllowed({
        childAgentInstanceId: TERTIARY,
        claimedParentAgentInstanceId: SECONDARY_B,
      }),
    ).resolves.toBe(false);
  });

  it("⑧ 合法 JSON 但缺 `bindings`/`recycledParents` ⇒ 兜底为空且不抛错", async () => {
    /**
     * 定向反例：`Array.isArray(parsed.bindings) ? … : []` 与 `recycledParents` 两路的 false 分支。
     * 语义：**向后兼容** —— 缺数组时按空处理，不得抛错让归属功能整体瘫痪。
     */
    const variants = [
      JSON.stringify({ schemaVersion: 1 }),
      JSON.stringify({ schemaVersion: 1, bindings: "not-an-array" }),
      JSON.stringify({ schemaVersion: 1, bindings: [], recycledParents: null }),
      JSON.stringify({ schemaVersion: 1, bindings: [], recycledParents: "nope" }),
    ];

    for (const variant of variants) {
      await fs.writeFile(
        path.join(stateDirectory, "agent-parent-bindings.json"),
        variant,
        "utf8",
      );
      const store = new ParentBindingStore({ stateDirectory });
      const controller = new ParentBindingController({ store });
      await expect(controller.resolveParentOf(TERTIARY), variant).resolves.toBeNull();
      await expect(
        controller.resolveHistoricalParentOf(TERTIARY),
        variant,
      ).resolves.toBeNull();
    }
  });
});

describe("COMM-01-02：释放与回收的边界（防抢占 / 幂等 / 未绑定）", () => {
  it("⑨ **非直属上级**不得释放该归属（防他人抢占）", async () => {
    /**
     * 定向反例：`releaseChild` 里"当前直属上级 ≠ 请求者"一路。
     * 语义：释放是**归属权**操作，只有当前直属上级能释放 ——
     * 否则任意主体都能把别人的子抢走（释放后再由自己绑定）。
     */
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });
    await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });

    const hijack = await controller.releaseChild({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_B,
    });
    expect(hijack.wasReleased).toBe(false);
    expect(String(hijack.reason)).toContain(SECONDARY_A);

    // 归属未被改变，且抢占者随后仍不能绑定
    await expect(controller.resolveParentOf(TERTIARY)).resolves.toBe(SECONDARY_A);
    const steal = await controller.bindChildToParent({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_B,
    });
    expect(steal.isBound).toBe(false);
  });

  it("⑩ 释放**未绑定**的子 ⇒ 如实报告无需释放（不伪造『已释放』）", async () => {
    /**
     * 定向反例：`releaseChild` 里 `active === null` 一路。
     * 语义：没有归属就如实说没有 —— 谎报"已释放"会让调用方以为后续可安全重绑。
     */
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });

    const outcome = await controller.releaseChild({
      childAgentInstanceId: TERTIARY,
      parentAgentInstanceId: SECONDARY_A,
    });

    expect(outcome.wasReleased).toBe(false);
    expect(String(outcome.reason)).toContain("没有生效归属");
  });

  it("⑪ 重复 `markParentRecycled` 幂等（第二次不得改变首次回收时间）", async () => {
    /**
     * 定向反例：`markParentRecycled` 里 `has(...)` 为真的一路。
     * 语义：回收时间是**审计事实**，重复上报不得把它刷新成"刚刚回收"。
     */
    const store = new ParentBindingStore({ stateDirectory });
    const controller = new ParentBindingController({ store });
    await controller.markParentRecycled({ parentAgentInstanceId: SECONDARY_A });
    const firstRaw = await fs.readFile(
      path.join(stateDirectory, "agent-parent-bindings.json"),
      "utf8",
    );
    const firstRecycled = JSON.parse(firstRaw) as {
      recycledParents: Array<{ parentAgentInstanceId: string; recycledAtIso: string }>;
    };
    const firstTimestamp = firstRecycled.recycledParents[0]!.recycledAtIso;

    // 隔一小段时间再报一次
    await new Promise((resolve) => setTimeout(resolve, 5));
    await controller.markParentRecycled({ parentAgentInstanceId: SECONDARY_A });

    const secondRaw = await fs.readFile(
      path.join(stateDirectory, "agent-parent-bindings.json"),
      "utf8",
    );
    const secondRecycled = JSON.parse(secondRaw) as {
      recycledParents: Array<{ parentAgentInstanceId: string; recycledAtIso: string }>;
    };
    expect(secondRecycled.recycledParents).toHaveLength(1);
    expect(secondRecycled.recycledParents[0]!.recycledAtIso).toBe(firstTimestamp);
  });
});
