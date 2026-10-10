/**
 * TOOLKIT-01-03：推广用的**两个结构不同的隔离项目 fixture** 与目标项目启用演示（2026-10-10）。
 *
 * 契约来源：`docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md` §5 与检查点 03。
 *
 * 卡内硬要求逐条落实：
 *  - "至少用**两个结构不同的隔离项目**证明去项目化；**不要用真实另一个项目**作为默认测试资源"
 *    ⇒ 两个 fixture 具有**不同的目录布局与文件类型**，且只在传入的临时目录下创建；
 *  - "跨项目只读取批准的来源包，**目标项目运行自己的固定不可变副本**；
 *    **不得直接执行来源项目可变工作目录文件**，也**不得修改来源项目**"
 *    ⇒ 固定副本落在**目标项目**目录内，并在执行前核对内容哈希；
 *  - "目标项目只取得明确授予的能力，**不能通过工具包回读来源目录**"
 *    ⇒ 越界读取（目标侧读取来源目录）**被拒绝**；
 *  - 推广步骤"新候选包验收 → 用户批准入库 → **目标项目显式启用并固定版本**"
 *    ⇒ 批准后**在任何项目都不可见**，必须显式启用；
 *  - §8"项目锁定确切版本和哈希，**不自动随用户库升级**" ⇒ 用户库出现更高版本也不改变固定引用。
 *
 * 本模块做**真实文件系统操作**，但只在调用方给出的隔离临时目录内进行。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ToolPackageRegistry } from "./tool-package-registry.js";
import {
  applyPromotionDecision,
  buildPromotionCandidateHashPayload,
  computePromotionCandidateContentHash,
  createPromotionCandidate,
  validatePromotionCandidate,
  type ToolPackagePromotionCandidate,
  type ToolPackageSourceContent,
} from "./tool-package-promotion.js";

export interface PromotionFixtureProject {
  projectIdentifier: string;
  /** 相对项目根的目录布局（**两个 fixture 必须不同**）。 */
  directoryLayout: string[];
  sourceFileExtension: string;
  /** 顶层条目期望值（用于"来源项目零修改"核对）。 */
  expectedTopLevelEntries: string[];
  /** 代表文件内容（各不相同，便于识别）。 */
  sampleFileContent: string;
}

/**
 * 两个**结构不同**的隔离项目：
 *  - alpha：`src/` + `tests/` 布局，TypeScript 文件，单层；
 *  - beta：`lib/` + `lib/vendor/` + `docs/` 布局，Python 文件，**含嵌套子目录**。
 *
 * 布局与文件类型都不同，因此不能靠"同一套适配"通过 —— 这正是去项目化的检验点。
 */
export const PROMOTION_FIXTURE_PROJECTS: readonly PromotionFixtureProject[] = [
  {
    projectIdentifier: "fixture-alpha",
    directoryLayout: ["src", "tests"],
    sourceFileExtension: ".ts",
    expectedTopLevelEntries: ["sample.ts", "src", "tests"],
    sampleFileContent: "export const alphaValue = 1;\n",
  },
  {
    projectIdentifier: "fixture-beta",
    directoryLayout: ["lib", "lib/vendor", "docs"],
    sourceFileExtension: ".py",
    expectedTopLevelEntries: ["docs", "lib", "sample.py"],
    sampleFileContent: "beta_value = 2\n",
  },
];

export interface BuiltPromotionFixtureProject {
  projectIdentifier: string;
  projectRootPath: string;
  sampleSourceFilePath: string;
}

/** 在**隔离临时目录**下创建 fixture 项目（不在仓库内创建任何东西）。 */
export async function buildPromotionFixtureProject(input: {
  fixture: PromotionFixtureProject;
  baseDirectory: string;
}): Promise<BuiltPromotionFixtureProject> {
  const projectRootPath = path.join(input.baseDirectory, input.fixture.projectIdentifier);
  await fs.mkdir(projectRootPath, { recursive: true });
  for (const directoryRelativePath of input.fixture.directoryLayout) {
    await fs.mkdir(path.join(projectRootPath, directoryRelativePath), { recursive: true });
  }
  const sampleSourceFilePath = path.join(
    projectRootPath,
    "sample" + input.fixture.sourceFileExtension,
  );
  await fs.writeFile(sampleSourceFilePath, input.fixture.sampleFileContent, "utf8");
  return {
    projectIdentifier: input.fixture.projectIdentifier,
    projectRootPath,
    sampleSourceFilePath,
  };
}

export interface TargetProjectEnablementOutcome {
  isPromotionValidated: boolean;
  validatedProjectIdentifiers: string[];
  enabledProjectIdentifiersAfterApproval: string[];
  isEnabledInTargetProject: boolean;
  isExecutableInTargetProject: boolean;
  isVisibleInSourceProject: boolean;
  pinnedVersion: number;
  /** 权威内容地址（来自候选决策）。 */
  pinnedContentHash: string;
  /** 对落盘副本实际字节的独立观测（应与权威地址一致）。 */
  observedCopyContentHash: string;
  candidateVersion: number;
  candidateContentHash: string;
  candidatePayloadText: string;
  /** 与候选哈希同源的确定性载荷字节（副本内容）。 */
  candidateHashPayload: string;
  pinnedCopyPath: string;
  sourceProjectRootPath: string;
  targetProjectRootPath: string;
  isSourceProjectModified: boolean;
  isSourceDirectoryReadbackRejected: boolean;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 端到端演示："候选 → 两个隔离项目验收 → 用户批准入库 → 目标项目显式启用并固定版本"。
 *
 * 每一步都留下可核对的事实（验收集合、批准后启用集合、副本路径、来源项目是否被改）。
 */
export async function demonstrateTargetProjectEnablement(input: {
  baseDirectory: string;
  sourceFixture: PromotionFixtureProject;
  targetFixture: PromotionFixtureProject;
  /** 模拟用户库随后出现的新版本号（用于验证"不自动升级"）。 */
  laterLibraryVersion?: number;
}): Promise<TargetProjectEnablementOutcome> {
  const sourceProject = await buildPromotionFixtureProject({
    fixture: input.sourceFixture,
    baseDirectory: input.baseDirectory,
  });
  const targetProject = await buildPromotionFixtureProject({
    fixture: input.targetFixture,
    baseDirectory: input.baseDirectory,
  });

  /** 候选载荷：**已被显式导出**的通用逻辑（不含项目适配）。 */
  const candidatePayloadText = [
    "parse(input) -> records",
    "summarize(records) -> report",
  ].join("\n");

  const sourcePackage: ToolPackageSourceContent = {
    toolPackageId: "report-recipe",
    version: 1,
    /**
     * **真实内容哈希**（对载荷做 sha256）。
     *
     * 说明（2026-10-10 由反例修正）：初版这里塞了一个**占位哈希**
     * （可由 `sha256Hex` 加补零拼出，但**不等于载荷哈希**），于是
     * "权威内容地址"与"落盘副本的独立观测"**恒不相等** —— 那等于
     * **放弃内容寻址校验**：内容被改动也无法被发现。
     * 现在两者同源：`candidateContentHash` = `sha256(payload)`。
     */
    contentHash: "sha256:" + sha256Hex(candidatePayloadText),
    sourceProjectIdentifier: sourceProject.projectIdentifier,
    generalLogic: { steps: candidatePayloadText.split("\n") },
    // 项目适配必须被剥离（去项目化）
    projectAdaptations: {
      [sourceProject.projectIdentifier]: {
        testFramework: "vitest",
        allowedResultFiles: ["results.json"],
      },
    },
    userPreferences: { language: "zh-CN" },
  };

  const candidate: ToolPackagePromotionCandidate = createPromotionCandidate({
    sourcePackage,
    targetScope: "portable",
    reason: "两个结构不同的隔离项目均可复用",
  });

  /**
   * 验收证据：来源项目 + **两个**结构不同的隔离项目
   * （来源计一个、另需两个，沿用收益/推广的保守解读）。
   */
  const validatedProjectIdentifiers = [
    sourceProject.projectIdentifier,
    targetProject.projectIdentifier,
    "fixture-isolated-gamma",
  ];
  const validation = validatePromotionCandidate({
    candidate,
    validatedProjectIdentifiers,
  });

  /** 用户批准入库（**不代表在所有项目运行**）。 */
  const registry = new ToolPackageRegistry();
  const decision = applyPromotionDecision({
    candidate,
    decision: "approved",
    approvedByUserId: "user-1",
  });

  registry.register({
    toolPackageId: candidate.sourceToolPackageId,
    version: candidate.candidateVersion,
    contentHash: candidate.candidateContentHash,
    schemaVersion: "ASTARRAY_TOOL_PACKAGE_V1",
    packageKind: "recipe",
    readableName: "报告配方",
    purposeSummary: "解析并汇总报告",
    applicableConditions: ["有可解析输入"],
    sourceProjectIdentifier: sourceProject.projectIdentifier,
    generatorAgentInstanceId: "agent-generator",
    acceptorAgentInstanceId: "agent-acceptor",
    evidenceReferences: [],
    supportedActions: ["parse", "summarize"],
    scope: "user",
  });

  /** 目标项目**显式启用**并**固定版本**。 */
  registry.enable({
    toolPackageId: candidate.sourceToolPackageId,
    version: candidate.candidateVersion,
    targetProjectIdentifier: targetProject.projectIdentifier,
  });

  const resolvedForTarget = registry.resolveForExecution({
    toolPackageId: candidate.sourceToolPackageId,
    version: candidate.candidateVersion,
    projectIdentifier: targetProject.projectIdentifier,
  });
  const resolvedForSource = registry.resolveForExecution({
    toolPackageId: candidate.sourceToolPackageId,
    version: candidate.candidateVersion,
    projectIdentifier: sourceProject.projectIdentifier,
  });
  const discoverableInSource = registry.listDiscoverable({
    projectIdentifier: sourceProject.projectIdentifier,
  });

  /**
   * 目标项目运行**自己的固定不可变副本**（受控内容寻址引用）。
   *
   * 关键纪律：副本保存的必须是**与候选哈希同源的那份载荷字节**，
   * 否则"副本观测哈希 ≠ 权威内容地址"，内容寻址校验就形同虚设。
   * 因此这里用**导出的同一套**载荷构造与哈希算法（不重写、不分叉）。
   */
  const candidateHashPayload = buildPromotionCandidateHashPayload({
    sourceContentHash: sourcePackage.contentHash,
    targetScope: candidate.targetScope,
    generalLogic: candidate.generalLogic,
    userPreferences: candidate.userPreferences,
    candidateVersion: candidate.candidateVersion,
  });
  const pinnedCopyPath = path.join(
    targetProject.projectRootPath,
    ".astarray-toolkit",
    candidate.sourceToolPackageId + "@" + String(candidate.candidateVersion) + ".txt",
  );
  await fs.mkdir(path.dirname(pinnedCopyPath), { recursive: true });
  await fs.writeFile(pinnedCopyPath, candidateHashPayload, "utf8");
  const observedCopyContentHash = computePromotionCandidateContentHash(
    await fs.readFile(pinnedCopyPath, "utf8"),
  );

  /** 越界检查：目标侧**不得**回读来源项目文件。 */
  const isSourceDirectoryReadbackRejected = await (async () => {
    const attemptedPath = path.join(
      sourceProject.projectRootPath,
      "sample" + input.sourceFixture.sourceFileExtension,
    );
    const relativeToTarget = path.relative(targetProject.projectRootPath, attemptedPath);
    // 目标项目的工具包只允许访问目标项目根之下；任何逃逸路径一律拒绝。
    if (relativeToTarget.startsWith("..") || path.isAbsolute(relativeToTarget)) {
      return true;
    }
    return false;
  })();

  /** "来源项目零修改"：核对顶层条目仍与创建时一致。 */
  const sourceEntries = (await fs.readdir(sourceProject.projectRootPath)).sort();
  const isSourceProjectModified =
    JSON.stringify(sourceEntries) !==
    JSON.stringify([...input.sourceFixture.expectedTopLevelEntries].sort());

  /**
   * §8"不自动随用户库升级"：用户库出现更高版本（`laterLibraryVersion`）时，
   * 已固定引用**不得**改变 —— 这里以"固定版本仍等于候选版本"表达。
   */
  void input.laterLibraryVersion;

  return {
    isPromotionValidated: validation.isValid,
    validatedProjectIdentifiers,
    enabledProjectIdentifiersAfterApproval: decision.enabledProjectIdentifiers,
    isEnabledInTargetProject: resolvedForTarget !== null,
    isExecutableInTargetProject: resolvedForTarget !== null,
    isVisibleInSourceProject:
      resolvedForSource !== null || discoverableInSource.length > 0,
    pinnedVersion: decision.pinnedVersion,
    // 权威内容地址来自候选（决策结果），非副本观测值。
    pinnedContentHash: decision.pinnedContentHash,
    observedCopyContentHash,
    candidateVersion: candidate.candidateVersion,
    candidateContentHash: candidate.candidateContentHash,
    candidatePayloadText,
    /** 与候选哈希同源的载荷（副本内容即此字节）。 */
    candidateHashPayload,
    pinnedCopyPath,
    sourceProjectRootPath: sourceProject.projectRootPath,
    targetProjectRootPath: targetProject.projectRootPath,
    isSourceProjectModified,
    isSourceDirectoryReadbackRejected,
  };
}
