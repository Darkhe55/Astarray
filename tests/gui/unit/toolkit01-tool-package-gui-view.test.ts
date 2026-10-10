/**
 * TOOLKIT-01-04 反例（2026-10-10，GUI 升级差异展示片）：
 * 卡内 §11 明确要求用户"能区分**草案/已验证/已启用**、项目专用/用户级/通用、
 * 授权/实际运行；**能看懂升级权限差异并拒绝**，能禁用和选择旧版"。
 *
 * 实测缺口：上一轮有了 CLI `tool-package describe`，但 **GUI/TUI 无任何展示** ⇒
 * 卡内"能看懂升级权限差异并拒绝"在界面上不成立（用户看不到差异就无法拒绝）。
 *
 * 本片钉住 GUI 只读视图的语义：
 *  - **始终存在**版本视图与升级差异视图（形状唯一，未提供时为空，**不伪造**条目）；
 *  - 每个版本必须携带**可辨识身份**：ID + 版本 + 内容哈希 + revision + 作用域 + 状态 +
 *    可读名称 + 来源项目 + 已启用项目列表；
 *  - **状态与作用域必须给出人工可读中文标签**（不得只给英文枚举让用户猜）；
 *  - 升级差异必须显式给出**是否需要重新授权**、新增/移除副作用、依赖与权限差异，
 *    并提供**可读摘要**（用户据此决定是否拒绝）；
 *  - 差异为空时也必须如实呈现"无差异"，而不是留白让人误以为有变化。
 *
 * 只跑纯函数，无 I/O、不联网、不用凭据。
 */
import { describe, expect, it } from "vitest";

import {
  buildGuiToolPackageView,
  type GuiToolPackageVersionInput,
} from "../../../packages/gui/src/application/gui-read-model.js";

function buildVersionInput(
  overrides: Partial<GuiToolPackageVersionInput> = {},
): GuiToolPackageVersionInput {
  return {
    toolPackageId: "report-formatter",
    version: 2,
    contentHash: "sha256:" + "b".repeat(64),
    revision: 3,
    scope: "project",
    status: "enabled",
    readableName: "测试报告格式化",
    sourceProjectIdentifier: "project-alpha",
    enabledProjectIdentifiers: ["project-alpha"],
    ...overrides,
  };
}

describe("TOOLKIT-01-04 GUI：工具包版本视图", () => {
  it("① 版本视图携带可辨识身份（ID/版本/哈希/revision/作用域/状态/来源/启用项目）", () => {
    const view = buildGuiToolPackageView({ versions: [buildVersionInput()] });
    expect(view.versions).toHaveLength(1);
    const entry = view.versions[0];
    expect(entry?.toolPackageId).toBe("report-formatter");
    expect(entry?.version).toBe(2);
    expect(entry?.contentHash).toBe("sha256:" + "b".repeat(64));
    expect(entry?.revision).toBe(3);
    expect(entry?.sourceProjectIdentifier).toBe("project-alpha");
    expect(entry?.enabledProjectIdentifiers).toEqual(["project-alpha"]);
    expect(entry?.readableName).toBe("测试报告格式化");
  });

  it("② 状态与作用域必须有人工可读中文标签（不得只给英文枚举）", () => {
    const statusLabels: Record<string, string> = {
      draft: "草案",
      validated: "已验证",
      enabled: "已启用",
      rejected: "已拒绝",
      disabled: "已停用",
      deprecated: "已废弃",
    };
    for (const [status, label] of Object.entries(statusLabels)) {
      const view = buildGuiToolPackageView({
        versions: [buildVersionInput({ status })],
      });
      expect(
        view.versions[0]?.statusDisplayLabel,
        "状态 " + status + " 必须有中文标签",
      ).toContain(label);
    }
    const scopeLabels: Record<string, string> = {
      project: "项目专用",
      user: "用户级",
      portable: "通用",
    };
    for (const [scope, label] of Object.entries(scopeLabels)) {
      const view = buildGuiToolPackageView({
        versions: [buildVersionInput({ scope })],
      });
      expect(
        view.versions[0]?.scopeDisplayLabel,
        "作用域 " + scope + " 必须有中文标签",
      ).toContain(label);
    }
  });

  it("③ 未知状态/作用域不得被静默当作已启用/项目专用", () => {
    const view = buildGuiToolPackageView({
      versions: [buildVersionInput({ status: "mystery-status", scope: "mystery-scope" })],
    });
    // 未知值必须如实标注为未知，绝不让用户误判为"已启用"
    expect(view.versions[0]?.statusDisplayLabel).not.toContain("已启用");
    expect(view.versions[0]?.statusDisplayLabel).toContain("未知");
    expect(view.versions[0]?.scopeDisplayLabel).toContain("未知");
  });

  it("④ 空输入 ⇒ 空视图（**不伪造**任何条目）", () => {
    const view = buildGuiToolPackageView({});
    expect(view.versions).toEqual([]);
    expect(view.upgradeDifferences).toEqual([]);
  });
});

describe("TOOLKIT-01-04 GUI：升级差异展示（用户据此决定是否拒绝）", () => {
  it("⑤ 新增副作用必须显式标注「需要重新授权」，并给出可读摘要", () => {
    const view = buildGuiToolPackageView({
      upgradeDifferences: [
        {
          toolPackageId: "report-formatter",
          fromVersion: 1,
          toVersion: 2,
          addedSideEffects: ["file-write"],
          removedSideEffects: [],
          dependencyDifferences: ["jsdom>=20"],
          permissionDifferences: ["write-file"],
          requiresReauthorization: true,
        },
      ],
    });
    expect(view.upgradeDifferences).toHaveLength(1);
    const difference = view.upgradeDifferences[0];
    expect(difference?.requiresReauthorization).toBe(true);
    expect(difference?.addedSideEffects).toEqual(["file-write"]);
    expect(difference?.dependencyDifferences).toEqual(["jsdom>=20"]);
    expect(difference?.permissionDifferences).toEqual(["write-file"]);
    // 可读摘要要能让用户看懂"多了什么权限/副作用"，从而决定拒绝
    expect(String(difference?.displaySummary)).toContain("file-write");
    expect(String(difference?.displaySummary)).toContain("需要重新授权");
  });

  it("⑥ 无新增副作用时必须如实说明**不需要**重新授权（不得留白）", () => {
    const view = buildGuiToolPackageView({
      upgradeDifferences: [
        {
          toolPackageId: "report-formatter",
          fromVersion: 1,
          toVersion: 2,
          addedSideEffects: [],
          removedSideEffects: [],
          dependencyDifferences: [],
          permissionDifferences: [],
          requiresReauthorization: false,
        },
      ],
    });
    const difference = view.upgradeDifferences[0];
    expect(difference?.requiresReauthorization).toBe(false);
    expect(String(difference?.displaySummary)).toContain("无需重新授权");
    // 差异为空也必须如实呈现"无差异"
    expect(String(difference?.displaySummary)).toContain("无差异");
  });

  it("⑦ 移除副作用也要呈现（不只是新增）", () => {
    const view = buildGuiToolPackageView({
      upgradeDifferences: [
        {
          toolPackageId: "report-formatter",
          fromVersion: 2,
          toVersion: 3,
          addedSideEffects: [],
          removedSideEffects: ["file-write"],
          dependencyDifferences: [],
          permissionDifferences: [],
          requiresReauthorization: false,
        },
      ],
    });
    expect(view.upgradeDifferences[0]?.removedSideEffects).toEqual(["file-write"]);
    expect(String(view.upgradeDifferences[0]?.displaySummary)).toContain("file-write");
  });
});
