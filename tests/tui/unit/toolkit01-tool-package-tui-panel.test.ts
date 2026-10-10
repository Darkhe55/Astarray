/**
 * TOOLKIT-01-04 反例（2026-10-10，TUI 面板片）：工具包版本与升级差异的**TUI 只读面板**。
 *
 * 卡内 §11：用户必须"能区分**草案/已验证/已启用**、项目专用/用户级/通用、授权/实际运行；
 * **能看懂升级权限差异并拒绝**，能禁用和选择旧版"。
 * 上一轮已把该视图接入 GUI `/state`，但 **TUI 仍无展示** ⇒ 卡片要求的"能看懂差异并拒绝"
 * 在 TUI 上不成立。
 *
 * 本片钉住 TUI 状态与渲染的语义：
 *  - 状态里**始终**有视图（未写入时为**空视图**，不伪造条目）；
 *  - 每条版本给出**可渲染标签**（状态/作用域中文，未知值显式标未知）；
 *  - 每条升级差异给出**是否需要重新授权**与**可读摘要**（用户据此拒绝），
 *    差异为空写"无差异"、无新增副作用写"无需重新授权"；
 *  - 渲染组件必须把上述关键信息**真的画出来**（用真实 Ink 渲染按行断言，而非只测状态）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { AppState } from "../../../packages/tui/src/ui/state/app-state.js";
import { ToolPackagePanel } from "../../../packages/tui/src/ui/components/panels.js";

describe("TOOLKIT-01-04 TUI：工具包版本视图", () => {
  it("① 未写入时为**空视图**（不伪造条目）", () => {
    const appState = new AppState();
    const view = appState.getToolPackageView();
    expect(view.versions).toEqual([]);
    expect(view.upgradeDifferences).toEqual([]);
  });

  it("② 写入后给出可渲染的中文状态/作用域标签；未知值显式标未知", () => {
    const appState = new AppState();
    appState.setToolPackages({
      versions: [
        {
          toolPackageId: "report-formatter",
          version: 2,
          contentHash: "sha256:" + "b".repeat(64),
          revision: 3,
          scope: "project",
          status: "enabled",
          readableName: "测试报告格式化",
          sourceProjectIdentifier: "project-alpha",
          enabledProjectIdentifiers: ["project-alpha"],
        },
        {
          toolPackageId: "mystery-package",
          version: 1,
          contentHash: "sha256:" + "c".repeat(64),
          revision: 1,
          scope: "mystery-scope",
          status: "mystery-status",
          readableName: "未知包",
          sourceProjectIdentifier: "project-beta",
          enabledProjectIdentifiers: [],
        },
      ],
      upgradeDifferences: [],
    });
    const view = appState.getToolPackageView();
    expect(view.versions).toHaveLength(2);
    expect(view.versions[0]?.statusDisplayLabel).toContain("已启用");
    expect(view.versions[0]?.scopeDisplayLabel).toContain("项目专用");
    // 未知值不得被乐观映射为"已启用"
    expect(view.versions[1]?.statusDisplayLabel).toContain("未知");
    expect(view.versions[1]?.scopeDisplayLabel).toContain("未知");
  });

  it("③ 升级差异必须带「是否需要重新授权」与可读摘要；空差异写无差异", () => {
    const appState = new AppState();
    appState.setToolPackages({
      versions: [],
      upgradeDifferences: [
        {
          toolPackageId: "report-formatter",
          fromVersion: 1,
          toVersion: 2,
          addedSideEffects: ["file-write"],
          removedSideEffects: [],
          dependencyDifferences: [],
          permissionDifferences: ["write-file"],
          requiresReauthorization: true,
        },
        {
          toolPackageId: "report-formatter",
          fromVersion: 2,
          toVersion: 3,
          addedSideEffects: [],
          removedSideEffects: [],
          dependencyDifferences: [],
          permissionDifferences: [],
          requiresReauthorization: false,
        },
      ],
    });
    const view = appState.getToolPackageView();
    expect(view.upgradeDifferences[0]?.requiresReauthorization).toBe(true);
    expect(String(view.upgradeDifferences[0]?.displaySummary)).toContain("需要重新授权");
    expect(String(view.upgradeDifferences[0]?.displaySummary)).toContain("file-write");
    expect(view.upgradeDifferences[1]?.requiresReauthorization).toBe(false);
    expect(String(view.upgradeDifferences[1]?.displaySummary)).toContain("无需重新授权");
    expect(String(view.upgradeDifferences[1]?.displaySummary)).toContain("无差异");
  });

  it("④ 真实 Ink 渲染必须把关键信息画出来（状态/作用域/是否需重新授权）", () => {
    const appState = new AppState();
    appState.setToolPackages({
      versions: [
        {
          toolPackageId: "report-formatter",
          version: 2,
          contentHash: "sha256:" + "b".repeat(64),
          revision: 3,
          scope: "project",
          status: "enabled",
          readableName: "测试报告格式化",
          sourceProjectIdentifier: "project-alpha",
          enabledProjectIdentifiers: ["project-alpha"],
        },
      ],
      upgradeDifferences: [
        {
          toolPackageId: "report-formatter",
          fromVersion: 1,
          toVersion: 2,
          addedSideEffects: ["file-write"],
          removedSideEffects: [],
          dependencyDifferences: [],
          permissionDifferences: ["write-file"],
          requiresReauthorization: true,
        },
      ],
    });
    const { lastFrame } = render(
      React.createElement(ToolPackagePanel, { view: appState.getToolPackageView() }),
    );
    const frame = String(lastFrame());
    expect(frame).toContain("report-formatter");
    expect(frame).toContain("已启用");
    expect(frame).toContain("项目专用");
    expect(frame).toContain("需要重新授权");
    expect(frame).toContain("file-write");
  });

  it("⑤ 清空后回到空视图（不得残留上一份数据）", () => {
    const appState = new AppState();
    appState.setToolPackages({
      versions: [
        {
          toolPackageId: "report-formatter",
          version: 1,
          contentHash: "sha256:" + "a".repeat(64),
          revision: 1,
          scope: "project",
          status: "enabled",
          readableName: "x",
          sourceProjectIdentifier: "project-alpha",
          enabledProjectIdentifiers: ["project-alpha"],
        },
      ],
      upgradeDifferences: [],
    });
    appState.clearToolPackages();
    const view = appState.getToolPackageView();
    expect(view.versions).toEqual([]);
    expect(view.upgradeDifferences).toEqual([]);
  });

  it("⑥ 面板确实接在真实 AstarrayApp 上（有数据时渲染，无数据时不占屏）", () => {
    /**
     * 只导出组件不足以证明"接线"：必须确认 `AstarrayApp` 真的渲染了它。
     * 这里用源码级接线断言（真实渲染 App 需要完整 controller 依赖，属端到端范畴），
     * 避免出现"组件写了但从未被渲染"的情况。
     */
    const appSource = readFileSync(
      path.resolve("packages/tui/src/ui/app.tsx"),
      "utf8",
    );
    expect(appSource).toContain("<ToolPackagePanel");
    expect(appSource).toContain("state.getToolPackageView()");
    // 有数据才渲染（没有工具包时不得占屏）
    expect(appSource).toMatch(/getToolPackageView\(\)\.versions\.length > 0/);
  });
});
