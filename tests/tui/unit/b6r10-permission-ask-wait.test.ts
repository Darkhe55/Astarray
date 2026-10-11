/**
 * B6R-10 覆盖率（2026-10-10）：`waitForPermissionAsk` 的**两处修复语义**。
 *
 * 该函数原为 `run-command.ts` 内**未导出**函数，只能靠真实 CLI 子进程间接覆盖
 * （v8 看不见子进程）⇒ 它承载的两处**产品行为修复长期零覆盖**。本轮把它提取到
 * `permission-ask-wait.ts` 并直接测试（提取**不改语义**，`run-command.ts` 导入同一实现）。
 *
 * 钉住的两条修复：
 *  ① **已消费的升级文本不得重复触发询问**（`startIndex` 切片）；
 *  ② `allow-once` 后任务短暂回到 `running`，此期间**不得立即收口**，
 *     必须给"授权后重跑"一个窗口，否则 CLI 在工具真正执行前就收口（**正向闭环失败**）。
 *
 * 另外钉住：终态失败立即返回、非 blocked 且无窗口立即返回、blocked 且只有非询问类升级立即返回、
 * 超时如实返回 null（不得伪造询问）。
 *
 * 只跑纯函数与假查询端口；不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import { buildPermissionAskFromEscalation } from "../../../packages/tui/src/cli/permission-ask-adjudication.js";
import { waitForPermissionAsk } from "../../../packages/tui/src/cli/permission-ask-wait.js";

/**
 * 构造**真实可解析**的权限询问升级文本。
 *
 * 格式取自实现本身（`ESCALATION_PATTERN`）：
 * `任务 <id> 需要权限调用 <工具>（<解释>），参数: <JSON>`
 * 这里先断言它确实可解析，避免用例与实现格式漂移后"静默失效"。
 */
function buildAskText(): string {
  const askText =
    '任务 task-1 需要权限调用 readFile（读取被拒文件），参数: {"filePath":"a.md"}';
  if (buildPermissionAskFromEscalation(askText) === null) {
    throw new Error("本用例的升级文本格式与实现不再一致，请同步 ESCALATION_PATTERN");
  }
  return askText;
}

describe("B6R-10：waitForPermissionAsk 的等待与收口语义", () => {
  it("① 未消费的询问文本 ⇒ 立即返回该询问", async () => {
    const askText = buildAskText();
    let queryCount = 0;
    const ask = await waitForPermissionAsk(
      [askText],
      1_000,
      async () => {
        queryCount += 1;
        return { status: "blocked" };
      },
    );
    expect(ask).not.toBeNull();
    // 命中询问即在**查询任务状态之前**返回
    expect(queryCount).toBe(0);
  });

  it("② **已消费**的询问文本不得重复触发：startIndex 跳过它", async () => {
    const askText = buildAskText();
    const ask = await waitForPermissionAsk(
      [askText],
      // 极短超时：若错误地把已消费文本再次当作询问，会立即返回非 null
      30,
      async () => ({ status: "running" }),
      1, // startIndex ⇒ 该文本视为已消费
    );
    expect(ask).toBeNull();
  });

  it("③ 终态失败 ⇒ 立即返回 null（不等待裁决）", async () => {
    let queryCount = 0;
    const ask = await waitForPermissionAsk(
      [],
      1_000,
      async () => {
        queryCount += 1;
        return { status: "blocked" };
      },
      0,
      () => true,
    );
    expect(ask).toBeNull();
    expect(queryCount).toBe(0);
  });

  it("④ 非 blocked 且**无推进窗口** ⇒ 立即返回 null", async () => {
    let queryCount = 0;
    const ask = await waitForPermissionAsk(
      [],
      1_000,
      async () => {
        queryCount += 1;
        return { status: "running" };
      },
    );
    expect(ask).toBeNull();
    expect(queryCount).toBe(1);
  });

  it("⑤ **推进窗口内**任务处于 running ⇒ 不立即收口，窗口耗尽后返回 null", async () => {
    let queryCount = 0;
    const startedAt = Date.now();
    const ask = await waitForPermissionAsk(
      [],
      1_000,
      async () => {
        queryCount += 1;
        return { status: "running" };
      },
      0,
      () => false,
      // 窗口 60ms ⇒ 必须多轮轮询后才收口（这正是"授权后重跑"需要的窗口）
      60,
    );
    expect(ask).toBeNull();
    expect(queryCount).toBeGreaterThan(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it("⑥ 推进窗口内**出现新询问** ⇒ 立即返回该询问（窗口不必耗尽）", async () => {
    const askText = buildAskText();
    let queryCount = 0;
    const ask = await waitForPermissionAsk(
      [askText],
      1_000,
      async () => {
        queryCount += 1;
        return { status: "running" };
      },
      0,
      () => false,
      60,
    );
    expect(ask).not.toBeNull();
    expect(queryCount).toBe(0);
  });

  it("⑦ blocked 且只有**非询问类**升级 ⇒ 立即返回 null（不再空等）", async () => {
    let queryCount = 0;
    const ask = await waitForPermissionAsk(
      ["普通升级：门禁判定失败"],
      1_000,
      async () => {
        queryCount += 1;
        return { status: "blocked" };
      },
    );
    expect(ask).toBeNull();
    expect(queryCount).toBe(1);
  });

  it("⑧ blocked 且**无任何升级**、超时耗尽 ⇒ 如实返回 null（不得伪造询问）", async () => {
    let queryCount = 0;
    const ask = await waitForPermissionAsk(
      [],
      40,
      async () => {
        queryCount += 1;
        return { status: "blocked" };
      },
    );
    expect(ask).toBeNull();
    expect(queryCount).toBeGreaterThan(1);
  });
});
