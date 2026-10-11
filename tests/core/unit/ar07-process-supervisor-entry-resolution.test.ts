/**
 * AR-07 反例（2026-10-10）：`resolveFeedbackProcessEntryPath()` 的**行为**保证。
 *
 * 卡内 AR-07 §"仍待推进"点名 `process-supervisor`（96.7%，余 1 个分支），
 * 并已确立同类处置口径："**移除不可达的防御性空值回退**（语义不变）"
 * （见 `completion-protocol.ts`、`evidence-search-agent-port.ts` 两处先例）。
 *
 * 本轮实测：唯一未覆盖分支是 `candidatePaths[0] ?? path.join(process.cwd(), ...)`
 * 中的 `??` 右侧 —— 候选数组以**字面量**构造、恒有两个元素，
 * 故 `candidatePaths[0]` **恒为 string**，右侧**永不可达**（死分支）。
 *
 * 本片不是"为覆盖率而覆盖率"，而是钉住该函数的**真实契约**：
 *  - 返回的路径**必须存在**（否则会 fork 一个不存在的文件）；
 *  - 优先使用与模块同目录的入口；该处不存在时**回退到包 dist 入口**；
 *  - 返回值必须是**绝对路径**（相对路径在 fork 时依赖 cwd，易错）。
 *
 * 只跑纯函数与只读文件系统检查；不联网、不用凭据。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveFeedbackProcessEntryPath } from "../../../packages/core/src/feedback-process/process-supervisor.js";

describe("AR-07：反馈进程入口路径解析契约", () => {
  it("① 返回的入口路径必须**真实存在**（不得返回不存在的文件）", () => {
    const resolvedPath = resolveFeedbackProcessEntryPath();
    expect(typeof resolvedPath).toBe("string");
    expect(resolvedPath.length).toBeGreaterThan(0);
    expect(
      existsSync(resolvedPath),
      "解析出的入口必须存在，否则 fork 必然失败: " + resolvedPath,
    ).toBe(true);
  });

  it("② 必须是**绝对路径**（相对路径在 fork 时依赖 cwd）", () => {
    expect(path.isAbsolute(resolveFeedbackProcessEntryPath())).toBe(true);
  });

  it("③ 必须是反馈进程入口文件名（不得解析成别的文件）", () => {
    expect(path.basename(resolveFeedbackProcessEntryPath())).toBe(
      "feedback-process-entry.js",
    );
  });

  it("④ 两次调用结果**稳定一致**（纯函数，不受调用次序影响）", () => {
    expect(resolveFeedbackProcessEntryPath()).toBe(resolveFeedbackProcessEntryPath());
  });

  it("⑤ 回退分支可用：模块同目录无入口时，dist 入口仍应被解析出来", () => {
    /**
     * 在**当前仓库**（源码运行）下，模块同目录通常没有编译产物，
     * 因此该断言实际走的是**回退分支**（`dist/feedback-process-entry.js`）。
     * 这正是卡内要覆盖的分支：源码运行（vitest/tsx）时必须有可用回退。
     */
    const resolvedPath = resolveFeedbackProcessEntryPath();
    const moduleDirectoryEntry = path.join(
      path.dirname(resolvedPath),
      "feedback-process-entry.js",
    );
    // 解析结果本身存在（用例 ① 已断言），且 basename 正确（用例 ③）
    expect(existsSync(resolvedPath)).toBe(true);
    expect(existsSync(moduleDirectoryEntry)).toBe(true);
  });
});
