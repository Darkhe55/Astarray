/**
 * COMM-01-02 切片①：唯一上级归属必须**产品可达**（不是"组件存在但未接通"）。
 *
 * 为什么单独有这条：卡内 §1 审计的核心警告是
 * "在生产源码检索到类定义，未找到该控制器的生产实例化引用；**不能以组件存在声称产品已接通**"。
 * 本会话第 18 轮交付 `agent-parent-binding-store.ts` 后，第 19 轮自查发现
 * 它**没有任何生产引用、也不在 `public-sdk` 导出里** ⇒ `dist` 中根本不可达，
 * 恰好重演了卡内点名的这个缺陷。本文件从**构建产物**证明已纠正。
 *
 * 断言对象是 `dist/public-sdk.js`（真实子进程导入并**实际执行**），
 * 不是源码路径 —— 只有这样才能证明它对产品可达。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * 超时预算（仓库既有约定）：本文件使用**子进程**，默认 5s 在满载争用下不足。
 * 断言不放宽，只给预算。
 */
vi.setConfig({ testTimeout: 60_000 });

const executeFile = promisify(execFile);

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-comm01-sdk-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("COMM-01-02：唯一上级归属的产品可达性（构建产物证据）", () => {
  it("① `dist/public-sdk.js` 可导入唯一上级归属入口，且**真的能判定**", async () => {
    const scriptDirectory = path.resolve(".tmp", "comm01-sdk-entry");
    await fs.mkdir(scriptDirectory, { recursive: true });
    const scriptPath = path.join(scriptDirectory, "parent-binding-sdk-entry.mjs");
    await fs.writeFile(
      scriptPath,
      `
import { ParentBindingController, ParentBindingStore } from __SDK_MODULE_URL__;
const stateDirectory = process.argv[2];
const store = new ParentBindingStore({ stateDirectory });
const controller = new ParentBindingController({ store });

// 唯一上级：先到者胜
const first = await controller.bindChildToParent({
  childAgentInstanceId: "child-1",
  parentAgentInstanceId: "parent-A",
});
const second = await controller.bindChildToParent({
  childAgentInstanceId: "child-1",
  parentAgentInstanceId: "parent-B",
});
const resolved = await controller.resolveParentOf("child-1");
const allowedToRealParent = await controller.isDeliveryAllowed({
  childAgentInstanceId: "child-1",
  claimedParentAgentInstanceId: "parent-A",
});
const allowedToOtherParent = await controller.isDeliveryAllowed({
  childAgentInstanceId: "child-1",
  claimedParentAgentInstanceId: "parent-B",
});

process.stdout.write(
  JSON.stringify({
    firstIsBound: first.isBound,
    secondIsBound: second.isBound,
    resolved,
    allowedToRealParent,
    allowedToOtherParent,
  }) + "\\n",
);
process.exit(0);
`.replace(
        "__SDK_MODULE_URL__",
        JSON.stringify(pathToFileURL(path.resolve("dist/public-sdk.js")).href),
      ),
      "utf8",
    );

    const result = await executeFile(
      process.execPath,
      [scriptPath, stateDirectory],
      { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 },
    );

    const payload = JSON.parse(result.stdout.trim()) as {
      firstIsBound: boolean;
      secondIsBound: boolean;
      resolved: string | null;
      allowedToRealParent: boolean;
      allowedToOtherParent: boolean;
    };

    // 入口真可达（否则上面的 import 就会失败）
    expect(payload.firstIsBound).toBe(true);
    // 唯一上级约束在**构建产物**里同样成立
    expect(payload.secondIsBound).toBe(false);
    expect(payload.resolved).toBe("parent-A");
    // 按地址出口只认唯一直属上级
    expect(payload.allowedToRealParent).toBe(true);
    expect(payload.allowedToOtherParent).toBe(false);
  });

  it("② 归属经构建产物写入后，父进程用源码路径重开仍能读到（跨进程持久化）", async () => {
    const scriptDirectory = path.resolve(".tmp", "comm01-sdk-entry");
    await fs.mkdir(scriptDirectory, { recursive: true });
    const scriptPath = path.join(scriptDirectory, "bind-only.mjs");
    await fs.writeFile(
      scriptPath,
      `
import { ParentBindingController, ParentBindingStore } from __SDK_MODULE_URL__;
const stateDirectory = process.argv[2];
const controller = new ParentBindingController({
  store: new ParentBindingStore({ stateDirectory }),
});
const bound = await controller.bindChildToParent({
  childAgentInstanceId: "child-persist",
  parentAgentInstanceId: "parent-P",
});
process.stdout.write(JSON.stringify(bound) + "\\n");
process.exit(0);
`.replace(
        "__SDK_MODULE_URL__",
        JSON.stringify(pathToFileURL(path.resolve("dist/public-sdk.js")).href),
      ),
      "utf8",
    );

    await executeFile(process.execPath, [scriptPath, stateDirectory], {
      cwd: process.cwd(),
      maxBuffer: 8 * 1024 * 1024,
    });

    // 父进程用**源码**入口读同一状态目录（证明落盘格式一致、不依赖进程内状态）
    const { ParentBindingController, ParentBindingStore } = await import(
      "../../../packages/core/src/orchestration/agent-parent-binding-store.js"
    );
    const controller = new ParentBindingController({
      store: new ParentBindingStore({ stateDirectory }),
    });
    await expect(controller.resolveParentOf("child-persist")).resolves.toBe("parent-P");
  });
});
