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

  it("⑦ 探针分支不得在 fetch 之后**立刻硬退出**，且必须禁止连接保活（Windows libuv 断言）", () => {
    /**
     * ## 由来（2026-11-08，**用真实凭据实测复现并修掉**）
     *
     * 卡内长期登记：`--probe-only` 在 **Windows + Node v24.18.0** 上退出路径触发
     * libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING) @ win/async.c:94`，
     * 退出码 `-1073740791`（fail-fast）。**此前未修的理由是"走成功路径需要真实凭据，
     * 改完无法验证"** —— 凭据可用后我实测**确认复现**，并定位为：
     * **紧跟 `await fetch` 的 `process.exit(0)`**（成功路径）触发该断言。
     *
     * 修法：① 探针请求头加 `connection: "close"`（不保活）；
     * ② 硬退出**之前**先让套接字收尾。
     * （**不能**只把 `process.exit(0)` 换成 `process.exitCode = 0`：
     * 那个退出同时是**本分支的终止手段**，去掉就会落到下面的完整实测。）
     *
     * 本用例把这两条钉成**契约**，防止坑回来。锚定**代码形态**而非裸子串
     * —— 说明注释里就写着 `process.exit(0)` 与 `connection: close`，
     * 裸子串匹配会得到空洞的绿（本会话已因此栽过四次）。
     */
    const scriptText = readFileSync(verificationScriptPath, "utf8");

    // ① 探针请求必须禁止保活
    expect(scriptText).toContain('connection: "close"');

    // 取探针分支文本（用花括号计数，避免被分支内的嵌套块截断）
    const branchMarker = 'if (process.argv.includes("--probe-only")) {';
    const branchStart = scriptText.indexOf(branchMarker);
    expect(branchStart, "找不到探针分支").toBeGreaterThan(-1);
    const openIndex = scriptText.indexOf("{", branchStart);
    let depth = 0;
    let closeIndex = -1;
    for (let index = openIndex; index < scriptText.length; index += 1) {
      const character = scriptText[index];
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          closeIndex = index;
          break;
        }
      }
    }
    expect(closeIndex, "探针分支没有闭合").toBeGreaterThan(openIndex);
    const probeBranch = scriptText.slice(branchStart, closeIndex + 1);

    // ② 退出前必须有"让套接字收尾"的一步（锚定代码形态）
    const settlePattern = /^\s*await new Promise\(\(resolve\) => setTimeout\(/m;
    const exitPattern = /^\s*process\.exit\(0\);\s*$/m;
    const settleIndex = probeBranch.search(settlePattern);
    const exitIndex = probeBranch.search(exitPattern);
    expect(settleIndex, "探针分支缺少退出前的收尾等待").toBeGreaterThan(-1);
    expect(exitIndex, "探针分支找不到成功的退出语句").toBeGreaterThan(-1);
    expect(
      settleIndex < exitIndex,
      "收尾等待必须在退出**之前**（否则等于没加）",
    ).toBe(true);
  });
});
