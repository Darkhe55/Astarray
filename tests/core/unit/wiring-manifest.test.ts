/**
 * 接线清单（wiring manifest）测试 —— 2026-11-08，第 152 轮。
 *
 * ## 要解决什么（用户提出、我复现过的真实问题）
 *
 * 本窗口勘测到的 **G1–G10** 缺口**全部**是同一形状：
 * **组件存在且完整，但从未被构造 / 未接入分发 / 或汇报恒真掩盖了未装配**。
 * 这类"遗漏编码"**不会**在编译期报错，也不会被模块级单测发现。
 *
 * ## 本测试怎么防
 *
 * 用一张**清单**把每个组件的"接线状态"写死，并**双向**校验：
 *
 * 1. 标 `constructed` 的组件 —— **必须**在装配/编排源码里出现 `new <类名>(`；
 *    否则说明**被拔了线**（回归）⇒ 红。
 * 2. 标 `unreachableByDesign` 的组件 —— **不得**出现 `new <类名>(`；
 *    否则说明**有人接上了但没更新本清单**（= 验收条件没做）⇒ 红。
 *
 * ⇒ 两个方向都靠"**清单与实际代码必须一致**"来兜底；任何一边漂移都会红。
 *
 * ## 它不是"证明已接线"的替代品
 *
 * 本清单**只**证明"构造点存在/不存在"，**不**证明"该接线按用户三项标准验收过"
 * （真实入口 + 拔线必失败 + 隔离包）。验收仍以各阶段的反例为准。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();

/** 扫描范围：装配层 + 编排层 + 运行时（"接线"必须发生在这些文件里才算数）。 */
const wiringSourceFiles = [
  "packages/core/src/application/application-runtime.ts",
  "packages/core/src/orchestration/mission-orchestrator.ts",
  "packages/core/src/orchestration/main-controller.ts",
];

interface WiringEntry {
  /** 组件类名（用于在源码里找 `new <类名>(`）。 */
  componentClassName: string;
  /**
   * `constructed`：必须被构造；
   * `unreachableByDesign`：必须**不**被构造（并在缺口总表里有对应条目）。
   */
  state: "constructed" | "unreachableByDesign";
  /** 为什么是这个状态（或指向缺口总表的小节）。 */
  reason: string;
}

const WIRING_MANIFEST: readonly WiringEntry[] = [
  // ---- 已接线（本窗口接上的，或既有必须构造的） ----
  {
    componentClassName: "LocalProgressAndCycleGuard",
    state: "constructed",
    reason: "G2（第 131 轮）：活锁/循环守卫，端口接入工具循环；缺省关但**必须**被构造以证明接线存在",
  },
  {
    componentClassName: "LocalRigorPolicyEngine",
    state: "constructed",
    reason: "G3a（第 132 轮）：高严谨性本地规则标记（在编排器里判定每个任务）",
  },
  {
    componentClassName: "DiagnosticEventStore",
    state: "constructed",
    reason: "DIAG 生产采集存储（第 96 轮接线，缺省关）",
  },
  {
    componentClassName: "MainController",
    state: "constructed",
    reason: "调度/租约/dispatch 的唯一控制器（装配层构造）",
  },

  // ---- 已知未接线（缺口总表对应小节） ----
  {
    componentClassName: "GitIntegrationCoordinator",
    state: "unreachableByDesign",
    reason: "G1（总表 §8）：T08 Git 集成整层不可达 —— 全仓无 new；用户硬约束：未完成前不得宣称完整 Git 集成",
  },
  {
    componentClassName: "LongToolCheckpoint",
    state: "unreachableByDesign",
    reason: "G5（总表 §7）：早停→检查点有界续跑的决策侧无消费者，执行器从未构造",
  },
  {
    componentClassName: "EvidenceCompletionGate",
    state: "unreachableByDesign",
    reason: "G3b（总表 §5.6）：证据包内容门禁仍是零使用",
  },
  {
    componentClassName: "ToolDocumentationRecallController",
    state: "unreachableByDesign",
    reason: "G4（总表 §D.4）：工具说明首次下发/后续回访未接线，且用户要求保留在返修清单",
  },
];

function readWiringSources(): string {
  return wiringSourceFiles
    .map((relativePath) => readFileSync(path.join(projectRoot, relativePath), "utf8"))
    .join("\n");
}

function countConstructorOccurrences(sourceText: string, className: string): number {
  return sourceText.split("new " + className + "(").length - 1;
}

describe("接线清单：清单与实际装配必须一致（双向）", () => {
  const wiringSourceText = readWiringSources();

  it("标 `constructed` 的组件必须在装配/编排源码里被构造（被拔线 ⇒ 红）", () => {
    const missing: string[] = [];
    for (const entry of WIRING_MANIFEST) {
      if (entry.state !== "constructed") continue;
      if (countConstructorOccurrences(wiringSourceText, entry.componentClassName) === 0) {
        missing.push(entry.componentClassName);
      }
    }
    expect(
      missing,
      "以下组件在清单里标为已接线，但装配/编排源码里找不到 `new <类名>(` ⇒ 接线被拔掉了",
    ).toEqual([]);
  });

  it("标 `unreachableByDesign` 的组件不得被构造（接了却没更新清单 ⇒ 红）", () => {
    const unexpectedlyConstructed: Array<{ componentClassName: string; reason: string }> = [];
    for (const entry of WIRING_MANIFEST) {
      if (entry.state !== "unreachableByDesign") continue;
      if (countConstructorOccurrences(wiringSourceText, entry.componentClassName) > 0) {
        unexpectedlyConstructed.push({
          componentClassName: entry.componentClassName,
          reason: entry.reason,
        });
      }
    }
    expect(
      unexpectedlyConstructed,
      "以下组件被构造了，但清单仍标为`设计上不可达` ⇒ 必须更新清单，并按用户三项标准补验收",
    ).toEqual([]);
  });

  it("清单自身完整性：每个条目都必须写明理由（不得留空）", () => {
    for (const entry of WIRING_MANIFEST) {
      expect(entry.componentClassName.length, "组件类名不得为空").toBeGreaterThan(0);
      expect(entry.reason.length, entry.componentClassName + " 必须写明理由").toBeGreaterThan(10);
    }
  });
});
