/**
 * TOOLKIT-01-02 反例（2026-10-10）：工作流配方的**有界偏序执行**。
 *
 * 卡内 §2/§3 与检查点 02 要求：
 *  - 工作流配方 = "已有工具可完成的稳定多步操作"：**有界偏序步骤 + 输入输出映射**，
 *    并且**通过现有工具执行网关调用**；
 *  - 完整保留**来源**与**逐步骤回执**；
 *  - **证明复用不是只 import** —— 即配方必须真的驱动受控工具执行，
 *    而不是仅仅 import 一个函数。
 *
 * 本轮钉住的语义：
 *  - 步骤偏序由 `dependsOnStepIdentifiers` 指定；**环**、**未知依赖**、**未知工具**一律拒绝（fail-closed）；
 *  - 参数映射只能取自"配方输入"或"已完成步骤的输出"，**不得引用未完成/失败步骤**，
 *    也不得凭空出现未声明的键；
 *  - 每一步必须产出**回执**（步骤 ID、工具名、参数、状态、输出引用）；
 *  - 执行确实经过注入的 `ToolPort`（用真实受控工具验证，而非只 import）；
 *  - 依赖失败的步骤**跳过**而不是带着坏输入硬跑；
 *  - 配方顶层**必选步骤**失败时整体判定为失败，不得声称成功。
 *
 * 只跑纯函数 + 真实内置工具，隔离临时目录；不联网、不用凭据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RecipeExecutionEngine,
  createRecipeLifecycle,
  validateRecipeDefinition,
  type WorkflowRecipeDefinition,
} from "../../../packages/core/src/toolkit/workflow-recipe-engine.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import {
  PermissionDecider,
  SessionAuthorizationManager,
} from "../../../packages/core/src/core/permission-policy.js";

let workspaceDirectory: string;
let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-toolkit02-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDirectory, "sample.txt"),
    "第一行\n第二行\n",
    "utf8",
  );
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 真实受控工具网关（devolve 模式下只读工具可用）。 */
function buildToolGateway() {
  const modeMachine = new ModeMachine("devolve");
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  const protectedStoragePolicy = new ProtectedStoragePolicy({
    stateDirectoryPath: temporaryDirectory,
  });
  return new PolicyWrapper({
    permissionDecider: new PermissionDecider(modeMachine, new SessionAuthorizationManager()),
    registry,
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    workerAllowedToolNames: null,
    nowUnixSeconds: () => Math.floor(Date.now() / 1000),
    getCurrentMode: () => modeMachine.getCurrentMode(),
    requestingAgentInstanceId: "agent-recipe",
    taskExecutionId: "task-recipe",
    protectedStoragePolicy,
  } as never);
}

function buildRecipe(overrides: Partial<WorkflowRecipeDefinition> = {}): WorkflowRecipeDefinition {
  return {
    recipeIdentifier: "read-then-list",
    version: 1,
    usedToolReferences: [
      { toolId: "readFile", toolRevision: 1 },
      { toolId: "listDirectory", toolRevision: 1 },
    ],
    steps: [
      {
        stepIdentifier: "step-read",
        toolName: "readFile",
        dependsOnStepIdentifiers: [],
        argumentMapping: { filePath: "$input.filePath" },
      },
      {
        stepIdentifier: "step-list",
        toolName: "listDirectory",
        dependsOnStepIdentifiers: ["step-read"],
        argumentMapping: { directoryPath: "$input.directoryPath" },
      },
    ],
    ...overrides,
  };
}

describe("TOOLKIT-01-02：配方定义校验", () => {
  it("① 环 / 未知依赖 / 未知工具 / 未声明工具引用 ⇒ 一律拒绝（fail-closed）", () => {
    const cycle = validateRecipeDefinition(
      buildRecipe({
        steps: [
          {
            stepIdentifier: "a",
            toolName: "readFile",
            dependsOnStepIdentifiers: ["b"],
            argumentMapping: { filePath: "$input.filePath" },
          },
          {
            stepIdentifier: "b",
            toolName: "readFile",
            dependsOnStepIdentifiers: ["a"],
            argumentMapping: { filePath: "$input.filePath" },
          },
        ],
      }),
    );
    expect(cycle.isValid).toBe(false);
    expect(String(cycle.reason)).toMatch(/环|cycle|循环/);

    const unknownDependency = validateRecipeDefinition(
      buildRecipe({
        steps: [
          {
            stepIdentifier: "a",
            toolName: "readFile",
            dependsOnStepIdentifiers: ["missing-step"],
            argumentMapping: { filePath: "$input.filePath" },
          },
        ],
      }),
    );
    expect(unknownDependency.isValid).toBe(false);

    const undeclaredTool = validateRecipeDefinition(
      buildRecipe({
        usedToolReferences: [{ toolId: "readFile", toolRevision: 1 }],
        steps: [
          {
            stepIdentifier: "a",
            toolName: "listDirectory",
            dependsOnStepIdentifiers: [],
            argumentMapping: { directoryPath: "$input.directoryPath" },
          },
        ],
      }),
    );
    expect(undeclaredTool.isValid).toBe(false);
    expect(String(undeclaredTool.reason)).toMatch(/tool|工具|未声明/);
  });

  it("② 参数映射只能引用配方输入或已完成步骤输出；凭空键必须拒绝", () => {
    const bogusMapping = validateRecipeDefinition(
      buildRecipe({
        steps: [
          {
            stepIdentifier: "a",
            toolName: "readFile",
            dependsOnStepIdentifiers: [],
            argumentMapping: { filePath: "$input.filePath", extra: "literal-ok-but-undeclared" },
          },
        ],
      }),
    );
    // 字面量允许，但引用了**不存在**的输入键必须拒绝
    const unknownInputReference = validateRecipeDefinition(
      buildRecipe({
        steps: [
          {
            stepIdentifier: "a",
            toolName: "readFile",
            dependsOnStepIdentifiers: [],
            argumentMapping: { filePath: "$input.notDeclared" },
          },
        ],
        declaredInputNames: ["filePath"],
      }),
    );
    expect(bogusMapping.isValid).toBe(true);
    expect(unknownInputReference.isValid).toBe(false);
    expect(String(unknownInputReference.reason)).toMatch(/input|输入|未声明/);
  });
});

describe("TOOLKIT-01-02：配方真实执行（证明复用不是只 import）", () => {
  it("③ 配方必须真的经工具网关执行，并给出逐步骤回执", async () => {
    const engine = new RecipeExecutionEngine({ toolPort: buildToolGateway() });
    const outcome = await engine.execute({
      recipe: buildRecipe(),
      input: { filePath: "sample.txt", directoryPath: "." },
      cancellationSignal: new AbortController().signal,
    });

    expect(outcome.isSuccessful).toBe(true);
    expect(outcome.stepReceipts.map((receipt) => receipt.stepIdentifier)).toEqual([
      "step-read",
      "step-list",
    ]);
    // 真实工具产出的内容（证明走了网关，而不是只 import）
    const readReceipt = outcome.stepReceipts[0];
    expect(readReceipt?.toolName).toBe("readFile");
    expect(readReceipt?.status).toBe("succeeded");
    expect(String(readReceipt?.outputText)).toContain("第一行");
    const listReceipt = outcome.stepReceipts[1];
    expect(String(listReceipt?.outputText)).toContain("sample.txt");
    // 逐步骤回执必须保留实际参数
    expect(JSON.parse(readReceipt?.argumentsJson ?? "{}")).toEqual({ filePath: "sample.txt" });
  });

  it("④ 依赖失败的步骤必须跳过（不得带坏输入硬跑）", async () => {
    const engine = new RecipeExecutionEngine({ toolPort: buildToolGateway() });
    const outcome = await engine.execute({
      recipe: buildRecipe(),
      // 读取一个不存在的文件 ⇒ step-read 失败 ⇒ step-list 必须跳过
      input: { filePath: "does-not-exist.txt", directoryPath: "." },
      cancellationSignal: new AbortController().signal,
    });

    expect(outcome.isSuccessful).toBe(false);
    const readReceipt = outcome.stepReceipts.find((r) => r.stepIdentifier === "step-read");
    const listReceipt = outcome.stepReceipts.find((r) => r.stepIdentifier === "step-list");
    expect(readReceipt?.status).toBe("failed");
    expect(listReceipt?.status).toBe("skipped-dependency-failed");
  });

  it("⑤ 回执必须保留来源（配方 ID/版本/步骤→工具映射）", async () => {
    const engine = new RecipeExecutionEngine({ toolPort: buildToolGateway() });
    const outcome = await engine.execute({
      recipe: buildRecipe(),
      input: { filePath: "sample.txt", directoryPath: "." },
      cancellationSignal: new AbortController().signal,
    });
    expect(outcome.recipeIdentifier).toBe("read-then-list");
    expect(outcome.recipeVersion).toBe(1);
    for (const receipt of outcome.stepReceipts) {
      expect(receipt.recipeIdentifier).toBe("read-then-list");
      expect(receipt.recipeVersion).toBe(1);
    }
  });
});

/**
 * 检查点 02 点名的链路："项目配方草案 → **独立验证** → 登记/启用 → 按需发现 → **实际调用**"。
 *
 * "独立验证"的两层含义在本组测试中都必须成立：
 *  1) 验证者与草案作者**不同** `agentInstanceId`（沿用 T08D"作者不能自验"纪律）；
 *  2) 验证必须证明"**复用不是只 import**" —— 即验证期真实驱动了工具网关。
 */
describe("TOOLKIT-01-02：草案 → 独立验证 → 登记/启用 → 发现 → 实际调用", () => {
  it("⑥ 验证者与作者相同必须拒绝；通过验证后登记并可在项目内发现与调用", async () => {
    const engine = new RecipeExecutionEngine({ toolPort: buildToolGateway() });
    const lifecycle = createRecipeLifecycle();

    const draft = await lifecycle.submitRecipeDraft({
      recipe: buildRecipe(),
      authorAgentInstanceId: "agent-author",
      sourceProjectIdentifier: "project-alpha",
    });
    expect(draft.status).toBe("draft");

    // 作者自验被拒（作者不能验收自己的产出）
    await expect(
      lifecycle.recordIndependentValidation({
        draftIdentifier: draft.draftIdentifier,
        validatorAgentInstanceId: "agent-author",
        executedToolNames: ["readFile", "listDirectory"],
        isExecutionSuccessful: true,
      }),
    ).rejects.toThrowError(/独立|作者|不同/);

    // 独立验证者通过：真实执行了配方声明的**全部**工具
    const validated = await lifecycle.recordIndependentValidation({
      draftIdentifier: draft.draftIdentifier,
      validatorAgentInstanceId: "agent-validator",
      executedToolNames: ["readFile", "listDirectory"],
      isExecutionSuccessful: true,
    });
    expect(validated.status).toBe("validated");

    const registered = await lifecycle.registerAndEnable({
      draftIdentifier: draft.draftIdentifier,
      toolPackageId: "read-then-list",
      version: 1,
      contentHash: "sha256:" + "e".repeat(64),
    });
    expect(registered.isEnabledInProject).toBe(true);

    // 按需发现：项目内可见
    expect(
      lifecycle
        .listDiscoverableRecipes({ projectIdentifier: "project-alpha" })
        .map((entry) => entry.toolPackageId),
    ).toEqual(["read-then-list"]);
    // 其它项目：不可见（复用不是跨项目通行证）
    expect(lifecycle.listDiscoverableRecipes({ projectIdentifier: "project-beta" })).toEqual([]);

    // 实际调用：真的经工具网关跑出内容
    const outcome = await lifecycle.executeRegisteredRecipe({
      toolPackageId: "read-then-list",
      version: 1,
      projectIdentifier: "project-alpha",
      input: { filePath: "sample.txt", directoryPath: "." },
      cancellationSignal: new AbortController().signal,
      recipeExecutionEngine: engine,
      recipe: buildRecipe(),
    });
    expect(outcome?.isSuccessful).toBe(true);
    expect(String(outcome?.stepReceipts[0]?.outputText)).toContain("第一行");
  });

  it("⑦ 验证期只跑了部分工具 ⇒ 必须判为未验证（不得凭 import 声称复用）", async () => {
    const lifecycle = createRecipeLifecycle();
    const draft = await lifecycle.submitRecipeDraft({
      recipe: buildRecipe(),
      authorAgentInstanceId: "agent-author",
      sourceProjectIdentifier: "project-alpha",
    });
    // 只执行了 readFile，却声称配方已验证 ⇒ 拒绝
    await expect(
      lifecycle.recordIndependentValidation({
        draftIdentifier: draft.draftIdentifier,
        validatorAgentInstanceId: "agent-validator",
        executedToolNames: ["readFile"],
        isExecutionSuccessful: true,
      }),
    ).rejects.toThrowError(/未执行|全部|复用|import/);
  });

  it("⑧ 执行失败的验证不得登记为 validated", async () => {
    const lifecycle = createRecipeLifecycle();
    const draft = await lifecycle.submitRecipeDraft({
      recipe: buildRecipe(),
      authorAgentInstanceId: "agent-author",
      sourceProjectIdentifier: "project-alpha",
    });
    await expect(
      lifecycle.recordIndependentValidation({
        draftIdentifier: draft.draftIdentifier,
        validatorAgentInstanceId: "agent-validator",
        executedToolNames: ["readFile", "listDirectory"],
        isExecutionSuccessful: false,
      }),
    ).rejects.toThrowError(/失败|未通过/);
  });
});
