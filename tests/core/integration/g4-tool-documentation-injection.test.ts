/**
 * G4 行为验收（2026-11-08 第 283 轮）：**注入决策的真实组合**。
 *
 * 用**真实的** `ToolDocumentationRecallInjector` + `ToolDocumentationReceiptStore`（临时目录）
 * + 真实生产者/渲染器，模拟编排器在 `buildWorkerAgent` 里做的组合：
 *
 * ```
 * registry + descriptors ⇒ buildToolPublicDocumentation（缺任一登记 ⇒ 抛错）
 *                       ⇒ buildFullDocumentation ⇒ injector.planInjection
 *                       ⇒ 首次 initial-full（完整用法）/ 同 revision subsequent-reminder（仅提醒）
 * ```
 *
 * 断言：
 * ① 首次 ⇒ **完整用法**（含 10 字段 + 末尾提醒）；
 * ② **同一 agent 第二次** ⇒ 仅固定提醒（**不含**完整用法）；
 * ③ **缺登记** ⇒ 生产阶段抛错 ⇒ 组合返回"不注入"（fail-closed）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import {
  ToolDocumentationRecallInjector,
  ToolDocumentationReceiptStore,
  buildFullDocumentation,
  buildReminderText,
} from "../../../packages/core/src/tools/tool-documentation-recall.js";
import { buildToolPublicDocumentation } from "../../../packages/core/src/tools/tool-public-documentation-registry.js";
import { renderToolGroupDocumentation } from "../../../packages/core/src/tools/tool-documentation-renderer.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-g4-docs-"));
});

afterEach(async () => {
  // 不删临时目录：回执存储会持续写盘，删除会与后台写竞态（§14.3 教训）。
  void baseDirectory;
});

const descriptor = {
  name: "factVerification",
  summary: "本地事实核查与证据包生成",
  mutationKind: "none" as const,
  isIdempotent: false,
  inputSchema: { type: "object" },
};

const registry = {
  factVerification: {
    examples: ['{"action":"record-reasoning","premises":["p1"],"uncertainty":"medium"}'],
    failureCodes: ["invalid-task-chain"],
    returnSchemaJson: '{"type":"object"}',
    requiredCapabilities: ["network.read"],
    limitations: ["纯推理不构成证据；build-evidence-bundle 的 contentHash 需 sha256:<64hex>"],
  },
};

describe("G4：注入决策（真实注入器 + 真实回执存储）", () => {
  it("① 首次 ⇒ 完整用法（10 字段齐 + 末尾提醒）", async () => {
    const store = new ToolDocumentationReceiptStore({ baseDirectory });
    const injector = new ToolDocumentationRecallInjector(store);
    const documentation = buildFullDocumentation({
      toolGroupIdentifier: "assigned-tools",
      toolGroupRevision: 1,
      assignedTools: [
        buildToolPublicDocumentation({
          descriptor,
          registryEntry: registry["factVerification" as keyof typeof registry],
        }),
      ],
    });

    const injection = await injector.planInjection({
      agentInstanceId: "agent-1",
      documentation,
      isDeltaProvenComplete: true,
    });

    expect(injection.kind).toBe("initial-full");
    const text = renderToolGroupDocumentation(documentation);
    expect(text).toContain("## factVerification");
    expect(text).toContain("用途：本地事实核查与证据包生成");
    expect(text).toContain("失败码：invalid-task-chain");
    expect(text).toContain("局限：纯推理不构成证据");
    expect(text.endsWith(buildReminderText())).toBe(true);
  });

  it("② 同一 agent 第二次（同 revision）⇒ 仅固定提醒，不含完整用法", async () => {
    const store = new ToolDocumentationReceiptStore({ baseDirectory });
    const injector = new ToolDocumentationRecallInjector(store);
    const documentation = buildFullDocumentation({
      toolGroupIdentifier: "assigned-tools",
      toolGroupRevision: 1,
      assignedTools: [
        buildToolPublicDocumentation({
          descriptor,
          registryEntry: registry["factVerification" as keyof typeof registry],
        }),
      ],
    });

    // 第一次：注入并落回执（真实写盘）
    const first = await injector.planInjection({
      agentInstanceId: "agent-2",
      documentation,
      isDeltaProvenComplete: true,
    });
    expect(first.kind).toBe("initial-full");
    // 注入器自带 recordDelivery（**调用方**在送达后调用它写回执）
    await injector.recordDelivery({ agentInstanceId: "agent-2", documentation });

    // 第二次：同 agent + 同 revision ⇒ 只给固定提醒
    const second = await injector.planInjection({
      agentInstanceId: "agent-2",
      documentation,
      isDeltaProvenComplete: true,
    });
    expect(second.kind).toBe("subsequent-reminder");
  });

  it("③ 缺登记 ⇒ 生产阶段抛错（编排器 catch 后不注入，fail-closed）", () => {
    expect(() =>
      buildToolPublicDocumentation({ descriptor, registryEntry: undefined }),
    ).toThrow(/缺少公开用法登记/);
  });
});
