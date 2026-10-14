/**
 * 反例（2026-10-23）：**重新授权记录的签发者必须是有该权限的角色**。
 *
 * 依据用户 2026-10-22 澄清：
 * > "签发者**不应该根据规则表设置**，应该由**拥有权限的角色**确定，
 * > **默认升级工具权限只有用户拥有**，并兼容可以**向下级逐层分发**权限的机制。"
 *
 * 此前 `issueRecord({ issuedBy })` 收的是**自由字符串** ⇒ 任何调用方都能自称"用户"，
 * 等于没有授权检查。本文件钉住取代它的本地可核验判定。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TOOL_UPGRADE_REAUTHORIZATION_CAPABILITY,
  ToolUpgradeAuthorizationController,
  ToolUpgradeAuthorizationStore,
} from "../../../packages/core/src/toolkit/tool-upgrade-authorization-grant.js";

let stateDirectory: string;
let store: ToolUpgradeAuthorizationStore;
let controller: ToolUpgradeAuthorizationController;

const AGENT = "tertiary-agent-1";
const OTHER_AGENT = "tertiary-agent-2";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-tool-upgrade-auth-"));
  store = new ToolUpgradeAuthorizationStore({ stateDirectory });
  controller = new ToolUpgradeAuthorizationController({ store });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("TOOLKIT-01-04：工具升级重新授权的签发资格", () => {
  it("① 用户本人 ⇒ 默认授权（无需任何授予记录）", async () => {
    const decision = await controller.resolveIssuingAuthority({
      authenticatedUserIdentifier: "user-1",
    });
    expect(decision).toEqual({ isAuthorized: true, authorityKind: "user" });
  });

  it("② Agent **默认不持有** ⇒ 拒绝（不得自称有权限）", async () => {
    const decision = await controller.resolveIssuingAuthority({
      issuingAgentInstanceId: AGENT,
    });
    expect(decision.isAuthorized).toBe(false);
    // 理由必须点明"未持有能力"（而不是含糊的"无权限"）
    expect(String((decision as { reason: string }).reason)).toContain("未持有");
  });

  it("③ 既无用户身份也无 Agent 身份 ⇒ 拒绝，且理由点明**默认只有用户持有**", async () => {
    const decision = await controller.resolveIssuingAuthority({});
    expect(decision.isAuthorized).toBe(false);
    expect(String((decision as { reason: string }).reason)).toContain("默认只有用户本人");
  });

  it("④ 用户授予 Agent 后 ⇒ 该 Agent 可签发；**未获授予的另一个 Agent 仍不可**", async () => {
    const granted = await controller.delegateCapability({
      authenticatedUserIdentifier: "user-1",
      grantedToAgentInstanceId: AGENT,
      expiresAtIso: null,
    });
    expect(granted.isGranted).toBe(true);

    await expect(
      controller.resolveIssuingAuthority({ issuingAgentInstanceId: AGENT }),
    ).resolves.toEqual({ isAuthorized: true, authorityKind: "delegated-agent" });
    // 另一个 Agent 不在授予范围内
    await expect(
      controller.resolveIssuingAuthority({ issuingAgentInstanceId: OTHER_AGENT }),
    ).resolves.toMatchObject({ isAuthorized: false });
  });

  it("⑤ **逐层分发不得放大**：自身有期限时不得授出无期限能力", async () => {
    await controller.delegateCapability({
      authenticatedUserIdentifier: "user-1",
      grantedToAgentInstanceId: AGENT,
      expiresAtIso: "2030-01-01T00:00:00.000Z",
    });

    const amplified = await controller.delegateCapability({
      delegatingAgentInstanceId: AGENT,
      grantedToAgentInstanceId: OTHER_AGENT,
      expiresAtIso: null,
    });

    expect(amplified.isGranted).toBe(false);
    expect(String(amplified.reason)).toContain("不得放大权限");
  });

  it("⑥ **逐层分发不得放大**：授出期限不得晚于自身期限", async () => {
    await controller.delegateCapability({
      authenticatedUserIdentifier: "user-1",
      grantedToAgentInstanceId: AGENT,
      expiresAtIso: "2030-01-01T00:00:00.000Z",
    });

    const later = await controller.delegateCapability({
      delegatingAgentInstanceId: AGENT,
      grantedToAgentInstanceId: OTHER_AGENT,
      expiresAtIso: "2031-01-01T00:00:00.000Z",
    });
    expect(later.isGranted).toBe(false);

    // 更窄的期限 ⇒ 允许（逐层分发本就应收窄）
    const narrower = await controller.delegateCapability({
      delegatingAgentInstanceId: AGENT,
      grantedToAgentInstanceId: OTHER_AGENT,
      expiresAtIso: "2029-01-01T00:00:00.000Z",
    });
    expect(narrower.isGranted).toBe(true);
  });

  it("⑦ **未持有能力的 Agent 不得分发**（不能凭空授权给别人）", async () => {
    const outcome = await controller.delegateCapability({
      delegatingAgentInstanceId: OTHER_AGENT,
      grantedToAgentInstanceId: "tertiary-agent-3",
      expiresAtIso: null,
    });

    expect(outcome.isGranted).toBe(false);
    expect(String(outcome.reason)).toContain("未持有");
  });

  it("⑧ 撤销后 ⇒ 立即失去签发资格（不因'曾经授过'继续放行）", async () => {
    const granted = await controller.delegateCapability({
      authenticatedUserIdentifier: "user-1",
      grantedToAgentInstanceId: AGENT,
      expiresAtIso: null,
    });
    await expect(
      controller.resolveIssuingAuthority({ issuingAgentInstanceId: AGENT }),
    ).resolves.toMatchObject({ isAuthorized: true });

    await controller.revokeCapability(String(granted.grantIdentifier));

    await expect(
      controller.resolveIssuingAuthority({ issuingAgentInstanceId: AGENT }),
    ).resolves.toMatchObject({ isAuthorized: false });
  });

  it("⑨ 已过期的能力 ⇒ 不再授权（按注入时钟判定）", async () => {
    const pastController = new ToolUpgradeAuthorizationController({
      store,
      nowIso: () => "2031-01-01T00:00:00.000Z",
    });
    await controller.delegateCapability({
      authenticatedUserIdentifier: "user-1",
      grantedToAgentInstanceId: AGENT,
      expiresAtIso: "2030-01-01T00:00:00.000Z",
    });

    await expect(
      pastController.resolveIssuingAuthority({ issuingAgentInstanceId: AGENT }),
    ).resolves.toMatchObject({ isAuthorized: false });
  });

  it("⑩ 授权记录必须持久化（新实例仍判定一致）且 fail-closed", async () => {
    await controller.delegateCapability({
      authenticatedUserIdentifier: "user-1",
      grantedToAgentInstanceId: AGENT,
      expiresAtIso: null,
    });

    const reopened = new ToolUpgradeAuthorizationController({
      store: new ToolUpgradeAuthorizationStore({ stateDirectory }),
    });
    await expect(
      reopened.resolveIssuingAuthority({ issuingAgentInstanceId: AGENT }),
    ).resolves.toMatchObject({ isAuthorized: true });

    // 文件损坏/版本不符 ⇒ 不得凭残缺内容授权
    await fs.writeFile(
      path.join(stateDirectory, "tool-upgrade-authorization-grants.json"),
      JSON.stringify({ schemaVersion: 999, grants: [{ capability: TOOL_UPGRADE_REAUTHORIZATION_CAPABILITY, grantedToAgentInstanceId: AGENT, revokedAtIso: null, expiresAtIso: null }] }),
      "utf8",
    );
    const afterCorruption = new ToolUpgradeAuthorizationController({
      store: new ToolUpgradeAuthorizationStore({ stateDirectory }),
    });
    await expect(
      afterCorruption.resolveIssuingAuthority({ issuingAgentInstanceId: AGENT }),
    ).resolves.toMatchObject({ isAuthorized: false });
  });
});
