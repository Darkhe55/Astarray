/**
 * SMART-01-04 真实运行证据的**可移植门禁**（2026-10-10）。
 *
 * 背景：SMART-01-04 卡内要求"模拟慢模型/长下级任务仍能接收新指令；180 秒内派发或
 * 如实超时/待澄清；关闭回收，UI 状态不冒充成果完成"。离线部分早已有 6+5 条反例，
 * 但"**真实运行**整机实测"长期空白（无 Provider 额度）。
 *
 * 本轮取得额度后由 `scripts/verify-u2-flash-continuous-reception.mjs` 真实跑通
 * （**退出码 0、判据 8/8**），判据落盘到 `.tmp/live-u2-flash/acceptance-verdict.json`。
 *
 * **为什么本文件存在**：`FAULT_INJECTION_MATRIX` 的 `evidenceFilePaths` 契约要求
 * 引用**仓库相对且以 `tests/` 开头**的路径（见
 * `tests/core/unit/reliability-fault-injection-matrix.test.ts` ⑨），
 * 而 `.tmp/` 是**产物目录**（已 gitignore、不进版本库）。因此：
 *  - **可移植部分**（无条件断言）：校验**验证脚本本身**仍然存在且保留关键契约
 *    （真实模型、180 秒上限、凭据字节一致断言）——换机器也成立；
 *  - **真实运行部分**（`skipIf` 无判据时跳过）：核对判据文件内容，防止
 *    "声称通过但产物不在/不通过"。
 *
 * 只读本地文件；不联网、不读凭据内容。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const verificationScriptPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-u2-flash-continuous-reception.mjs",
);
const verdictPath = path.join(
  repositoryRoot,
  ".tmp",
  "live-u2-flash",
  "acceptance-verdict.json",
);
const hasLiveVerdict = existsSync(verdictPath);

describe("SMART-01-04：真实运行验证脚本的**契约**（可移植）", () => {
  it("① 验证脚本存在（真实运行入口不得被删除）", () => {
    expect(existsSync(verificationScriptPath)).toBe(true);
  });

  it("② 脚本必须使用卡内点名的真实慢模型与 180 秒派发上限", () => {
    const scriptText = readFileSync(verificationScriptPath, "utf8");
    // 真实模型标识（不是注入延迟的假模型）
    expect(scriptText).toMatch(/u2-flash/);
    // 卡内明文的 180 秒
    expect(scriptText).toMatch(/180_000/);
    // "在途期间仍能接收新指令"必须是判据之一
    expect(scriptText).toMatch(/在途期间仍能接收新指令/);
  });

  it("③ 脚本必须断言**未写入受保护凭据**（凭据字节一致）", () => {
    const scriptText = readFileSync(verificationScriptPath, "utf8");
    expect(scriptText).toMatch(/provider-credentials\.json/);
    expect(scriptText).toMatch(/未写入受保护凭据/);
  });

  it("④ 脚本不得打印密钥（不得出现 console.* 直接输出 apiKey）", () => {
    const scriptText = readFileSync(verificationScriptPath, "utf8");
    /** 允许读取 `apiKey` 用于构造请求头，但**不得**把它打出来。 */
    expect(scriptText).not.toMatch(/console\.[a-z]+\([^)]*apiKey/);
  });
});

describe.skipIf(!hasLiveVerdict)("SMART-01-04：真实运行判据（有产物时核对）", () => {
  it("⑤ 判据必须是通过状态且无失败项（不得声称通过而实际有失败）", () => {
    const verdict = JSON.parse(readFileSync(verdictPath, "utf8")) as {
      isPassed?: boolean;
      failedCheckNames?: string[];
      checks?: Array<{ passed?: boolean }>;
      modelIdentifier?: string;
    };
    expect(verdict.isPassed).toBe(true);
    expect(verdict.failedCheckNames).toEqual([]);
    // 逐条判据都必须是 passed（防止汇总字段与明细不一致）
    expect(verdict.checks?.every((check) => check.passed === true)).toBe(true);
    expect(verdict.modelIdentifier).toBe("u2-flash");
  });

  it("⑥ 判据必须覆盖卡内三要素：在途接收、派发≠完成、关闭回收", () => {
    const verdict = JSON.parse(readFileSync(verdictPath, "utf8")) as {
      checks?: Array<{ name?: string }>;
    };
    const checkNames = (verdict.checks ?? []).map((check) => String(check.name));
    expect(checkNames.join("|")).toMatch(/在途期间仍能接收新指令/);
    expect(checkNames.join("|")).toMatch(/派发 ≠ 完成|派发状态与成果完成可区分/);
    expect(checkNames.join("|")).toMatch(/关闭回收|收敛到终态/);
  });
});
