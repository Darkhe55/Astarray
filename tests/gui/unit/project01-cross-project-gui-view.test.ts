/**
 * PROJECT-01-04 反例（2026-10-10）：跨项目授权必须进入 **GUI 只读快照**，且人工可分辨副本与原件。
 *
 * 卡内验收："A/B/C项目及多个同级个体可追溯、不串数据；**人工能分辨副本与原件**"。
 * 现状缺口（本文件在实现前必须失败）：GUI 只读快照只有任务与指令窗口，
 * 跨项目授权/副本信息**完全不可见** ⇒ GUI 侧无法追溯，也无法分辨副本与原件。
 *
 * 本文件钉住 GUI 读模型最窄闭环：
 *  - `buildGuiSnapshot` 输出 `crossProject`（授权逐条：来源/目标/操作/状态/任务）；
 *  - 副本回执必须**显式标注为副本**并保留来源引用（人工可分辨）；
 *  - 缺失能力时输出空列表（不伪造授权、不 500）；
 *  - 快照仍为脱敏只读 JSON（不含凭据）。
 */
import { describe, expect, it } from "vitest";

import {
  buildGuiCrossProjectView,
  buildGuiSnapshot,
  createGuiTaskTracker,
} from "../../../packages/gui/src/application/gui-read-model.js";

describe("PROJECT-01-04：GUI 只读快照中的跨项目授权与副本", () => {
  it("① 快照必须携带跨项目授权列表（来源/目标/操作/状态/任务齐备）", () => {
    const snapshot = buildGuiSnapshot({
      sessionId: "gui-session",
      mode: "assist",
      tracker: createGuiTaskTracker(),
      crossProject: {
        authorizations: [
          {
            authorizationIdentifier: "auth-1",
            sourceProjectIdentifier: "project-a",
            targetProjectIdentifier: "project-b",
            operationKind: "read",
            state: "active",
            taskIdentifier: "T-001",
          },
        ],
        copyReceipts: [],
      },
    });
    expect(snapshot.crossProject.authorizations).toHaveLength(1);
    expect(snapshot.crossProject.authorizations[0]?.sourceProjectIdentifier).toBe("project-a");
    expect(snapshot.crossProject.authorizations[0]?.targetProjectIdentifier).toBe("project-b");
    expect(snapshot.crossProject.authorizations[0]?.taskIdentifier).toBe("T-001");
  });

  it("② 副本回执必须显式标注为副本并保留来源引用（人工可分辨副本与原件）", () => {
    const view = buildGuiCrossProjectView({
      authorizations: [],
      copyReceipts: [
        {
          receiptIdentifier: "copy-1",
          sourceProjectIdentifier: "project-a",
          sourceRevision: 3,
          targetProjectIdentifier: "project-b",
          sourceResourcePath: "docs/spec.md",
          targetResourcePath: "docs/spec-copy.md",
          isCopyOfExternalSource: true,
        },
      ],
    });
    expect(view.copyReceipts).toHaveLength(1);
    const receipt = view.copyReceipts[0];
    expect(receipt?.isCopyOfExternalSource).toBe(true);
    // 人工可分辨：显示标签必须含"副本"且带来源引用
    expect(receipt?.displayLabel).toContain("副本");
    expect(receipt?.displayLabel).toContain("project-a");
    expect(receipt?.displayLabel).toContain("r3");
  });

  it("③ 未提供跨项目信息 ⇒ 空列表（不伪造授权），快照仍可用", () => {
    const snapshot = buildGuiSnapshot({
      sessionId: "gui-session",
      mode: "assist",
      tracker: createGuiTaskTracker(),
    });
    expect(snapshot.crossProject.authorizations).toHaveLength(0);
    expect(snapshot.crossProject.copyReceipts).toHaveLength(0);
  });

  it("④ 快照保持脱敏：序列化后不得含凭据", () => {
    const serialized = JSON.stringify(
      buildGuiSnapshot({
        sessionId: "gui-session",
        mode: "assist",
        tracker: createGuiTaskTracker(),
        crossProject: {
          authorizations: [
            {
              authorizationIdentifier: "auth-1",
              sourceProjectIdentifier: "project-a",
              targetProjectIdentifier: "project-b",
              operationKind: "import-copy",
              state: "active",
              taskIdentifier: "T-001",
            },
          ],
          copyReceipts: [],
        },
      }),
    );
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
  });
});
