/**
 * TOOLKIT-01-03 反例（2026-10-10，收官片）：第二个**结构不同**的隔离项目 fixture
 * 与"目标项目显式启用并**固定版本**"的端到端演示。
 *
 * 卡内 §5 与检查点 03 要求：
 *  - "至少用**两个结构不同的隔离项目**证明去项目化；**不要用真实另一个项目**作为默认测试资源"；
 *  - "跨项目只读取批准的来源包，**目标项目运行自己的固定不可变副本/受控内容寻址引用**；
 *    **不得直接执行来源项目可变工作目录文件**，也**不得修改来源项目**"；
 *  - "目标项目只取得明确授予的能力，**不能通过工具包回读来源目录**"；
 *  - 推广步骤："新候选包验收 → 用户批准入库 → **目标项目显式启用并固定版本**"；
 *  - §8："项目锁定确切版本和哈希，**不自动随用户库升级**"。
 *
 * 上一轮已实现候选生成与判定（去项目化、敏感内容、批准不启用），
 * 但**没有**"两个结构不同项目"的隔离 fixture，也**没有**端到端的
 * "候选验收 → 批准 → 目标项目显式启用固定版本 → 可执行且不越界"演示。
 *
 * 只跑本地隔离临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROMOTION_FIXTURE_PROJECTS,
  buildPromotionFixtureProject,
  demonstrateTargetProjectEnablement,
} from "../../../packages/core/src/toolkit/promotion-fixtures.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-toolkit-fixtures-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("TOOLKIT-01-03：两个**结构不同**的隔离项目 fixture", () => {
  it("① 必须提供两个结构不同的 fixture（不同目录布局/文件类型），不得同构", async () => {
    expect(PROMOTION_FIXTURE_PROJECTS).toHaveLength(2);
    const [first, second] = PROMOTION_FIXTURE_PROJECTS;
    expect(first?.projectIdentifier).not.toBe(second?.projectIdentifier);
    // 结构不同：目录布局与文件扩展名都不同
    expect(first?.directoryLayout).not.toEqual(second?.directoryLayout);
    expect(first?.sourceFileExtension).not.toBe(second?.sourceFileExtension);
  });

  it("② fixture 必须在隔离临时目录中真实落盘，且**不在仓库内**", async () => {
    const created = await buildPromotionFixtureProject({
      fixture: PROMOTION_FIXTURE_PROJECTS[0]!,
      baseDirectory: stateDirectory,
    });
    const entries = await fs.readdir(created.projectRootPath);
    expect(entries.sort()).toEqual([...PROMOTION_FIXTURE_PROJECTS[0]!.expectedTopLevelEntries].sort());
    // 隔离：路径必须在传入的临时目录之下
    expect(created.projectRootPath.startsWith(stateDirectory)).toBe(true);
    expect(created.projectRootPath).not.toContain(".astarray");
  });

  it("③ 每个 fixture 都能被独立创建（同一测试内不互相污染）", async () => {
    const firstProject = await buildPromotionFixtureProject({
      fixture: PROMOTION_FIXTURE_PROJECTS[0]!,
      baseDirectory: stateDirectory,
    });
    const secondProject = await buildPromotionFixtureProject({
      fixture: PROMOTION_FIXTURE_PROJECTS[1]!,
      baseDirectory: stateDirectory,
    });
    expect(firstProject.projectRootPath).not.toBe(secondProject.projectRootPath);
    // 两者都能读到自己的代表文件
    const firstContent = await fs.readFile(firstProject.sampleSourceFilePath, "utf8");
    const secondContent = await fs.readFile(secondProject.sampleSourceFilePath, "utf8");
    expect(firstContent.length).toBeGreaterThan(0);
    expect(secondContent.length).toBeGreaterThan(0);
  });
});

describe("TOOLKIT-01-03：候选验收 → 批准 → 目标项目显式启用并固定版本", () => {
  it("④ 端到端：目标项目显式启用后按**固定版本**执行，且来源项目零修改", async () => {
    const outcome = await demonstrateTargetProjectEnablement({
      baseDirectory: stateDirectory,
      sourceFixture: PROMOTION_FIXTURE_PROJECTS[0]!,
      targetFixture: PROMOTION_FIXTURE_PROJECTS[1]!,
    });

    // 候选经两个隔离项目验证才可入库
    expect(outcome.isPromotionValidated).toBe(true);
    expect(outcome.validatedProjectIdentifiers.length).toBeGreaterThanOrEqual(3);

    // 批准只入库，不在任何项目自动启用
    expect(outcome.enabledProjectIdentifiersAfterApproval).toEqual([]);

    // 目标项目**显式启用**后才可执行，且固定到候选版本
    expect(outcome.isEnabledInTargetProject).toBe(true);
    expect(outcome.pinnedVersion).toBe(outcome.candidateVersion);
    expect(outcome.pinnedContentHash).toBe(outcome.candidateContentHash);
    expect(outcome.isExecutableInTargetProject).toBe(true);

    // 来源项目在其它项目可见性上不自动放开
    expect(outcome.isVisibleInSourceProject).toBe(false);

    // **来源项目零修改**：源项目目录内容与创建时一致
    expect(outcome.isSourceProjectModified).toBe(false);
    const sourceEntries = await fs.readdir(outcome.sourceProjectRootPath);
    expect(sourceEntries.sort()).toEqual(
      [...PROMOTION_FIXTURE_PROJECTS[0]!.expectedTopLevelEntries].sort(),
    );
  });

  it("⑤ 目标项目运行的是**自己的固定副本**，不直接执行来源项目可变文件", async () => {
    const outcome = await demonstrateTargetProjectEnablement({
      baseDirectory: stateDirectory,
      sourceFixture: PROMOTION_FIXTURE_PROJECTS[0]!,
      targetFixture: PROMOTION_FIXTURE_PROJECTS[1]!,
    });
    // 副本必须落在**目标项目**目录内，而不是来源项目目录内
    expect(outcome.pinnedCopyPath.startsWith(outcome.targetProjectRootPath)).toBe(true);
    expect(outcome.pinnedCopyPath.startsWith(outcome.sourceProjectRootPath)).toBe(false);
    // 副本保存的是**与候选哈希同源的载荷字节**（受控内容寻址引用）
    const pinnedCopyContent = await fs.readFile(outcome.pinnedCopyPath, "utf8");
    expect(pinnedCopyContent).toBe(outcome.candidateHashPayload);
    // 权威内容地址与**落盘副本的独立观测**必须一致（副本确为被批准的那份内容）
    expect(outcome.observedCopyContentHash).toBe(outcome.pinnedContentHash);
    expect(outcome.pinnedContentHash).toBe(outcome.candidateContentHash);
  });

  it("⑥ 不得通过工具包**回读来源目录**（越界读取被拒绝）", async () => {
    const outcome = await demonstrateTargetProjectEnablement({
      baseDirectory: stateDirectory,
      sourceFixture: PROMOTION_FIXTURE_PROJECTS[0]!,
      targetFixture: PROMOTION_FIXTURE_PROJECTS[1]!,
    });
    // 尝试从目标项目侧读取来源项目的文件 ⇒ 必须被拒
    expect(outcome.isSourceDirectoryReadbackRejected).toBe(true);
  });

  it("⑦ 固定版本**不自动随用户库升级**：更高版本出现后目标仍用旧版", async () => {
    const outcome = await demonstrateTargetProjectEnablement({
      baseDirectory: stateDirectory,
      sourceFixture: PROMOTION_FIXTURE_PROJECTS[0]!,
      targetFixture: PROMOTION_FIXTURE_PROJECTS[1]!,
      /** 模拟用户库随后出现了更高的新版本。 */
      laterLibraryVersion: 99,
    });
    expect(outcome.pinnedVersion).toBe(outcome.candidateVersion);
    expect(outcome.pinnedVersion).not.toBe(99);
    expect(outcome.isExecutableInTargetProject).toBe(true);
  });
});
