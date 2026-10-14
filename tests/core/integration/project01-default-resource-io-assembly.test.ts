/**
 * PROJECT-01-03 反例（2026-10-30）：**默认装配**下 SDK 就能真实执行跨项目借阅，
 * 且仍然是**受控**的。
 *
 * ## 本文件针对的缺口（2026-10-29 复查仍成立）
 *
 * `CrossProjectResourceIoPort` 此前只有 CLI 的**裸 `fs`** 实现
 * ⇒ SDK/GUI 路径的 `crossProjectResourceIo` **恒为 `null`**
 * ⇒ `importCrossProjectResource` 只能 fail-closed 返回
 * `cross-project-resource-io-unavailable`。
 *
 * ## 与既有 `cross-project-sdk-entry.test.ts` 的区别（关键）
 *
 * 那个文件**显式注入**了 `crossProjectResourceIo: buildResourceIo()`，
 * 因此它证明的是"**注入端口后**入口可用"，**不能**证明"**不注入**时可用"。
 * 本文件**刻意不注入**，断言默认装配就可用 —— 这才是缺口所在。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let baseDirectory: string;
let workspaceRoot: string;
let sourceProjectRoot: string;
let targetProjectRoot: string;
let sourceFilePath: string;
let targetFilePath: string;

const SOURCE_PROJECT = "project-a";
const TARGET_PROJECT = "project-b";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project01-default-"));
  // 工作区根 = 临时目录；两个项目根都在其中（越界反例另有其文件）
  workspaceRoot = baseDirectory;
  sourceProjectRoot = path.join(baseDirectory, "project-a");
  targetProjectRoot = path.join(baseDirectory, "project-b");
  sourceFilePath = path.join(sourceProjectRoot, "docs", "spec.md");
  targetFilePath = path.join(targetProjectRoot, "docs", "spec-copy.md");
  await fs.mkdir(path.dirname(sourceFilePath), { recursive: true });
  await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** **刻意不注入 `crossProjectResourceIo`** —— 这正是本文件要验证的。 */
async function createApplicationWithoutInjectedPort(): Promise<AstarrayApplicationFacade> {
  return AstarrayApplicationFacade.create({
    /**
     * 状态目录落在**来源项目根内**的 `.astarray/` —— 这是真实产品布局，
     * 也是 `ProtectedStoragePolicy` 能识别该保管库的前提
     * （跨项目只读的既有反例同样按此布局构造）。
     */
    stateDirectory: path.join(sourceProjectRoot, ".astarray"),
    workspaceRootPath: workspaceRoot,
    mode: "assist",
    runtime: "mock",
    concurrency: 2,
    failureThreshold: 3,
  } as never);
}

async function grantImportAuthorization(
  application: AstarrayApplicationFacade,
  argumentsHash: string,
): Promise<void> {
  await application.grantCrossProjectAuthorizationForAcceptance({
    authorizationIdentifier: "auth-import",
    sourceProjectIdentifier: SOURCE_PROJECT,
    sourceProjectRevision: 3,
    targetProjectIdentifier: TARGET_PROJECT,
    operationKind: "import-copy",
    resourcePathPrefixes: ["docs/"],
    argumentsHash,
  });
}

describe("PROJECT-01-03：默认装配下 SDK 就能真实跨项目导入（无需注入端口）", () => {
  it("① **不注入端口**时导入仍能真实写出副本（此前恒为 unavailable）", async () => {
    const content = "# 默认装配导入\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    const application = await createApplicationWithoutInjectedPort();
    try {
      await grantImportAuthorization(application, "hash-default-import");

      const result = await application.importCrossProjectResource({
        authorizationIdentifier: "auth-import",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: "docs/spec.md",
        targetResourcePath: "docs/spec-copy.md",
        absoluteSourcePath: sourceFilePath,
        sourceProjectRootPath: sourceProjectRoot,
        absoluteTargetPath: targetFilePath,
        targetProjectRootPath: targetProjectRoot,
        sourceRevision: 3,
        argumentsHash: "hash-default-import",
        nowIso: "2026-10-30T00:00:00.000Z",
      });

      // 关键：不再是 cross-project-resource-io-unavailable
      expect(result.outcome).not.toBe("cross-project-resource-io-unavailable");
      expect(result.outcome).toBe("imported-copy");
      // 真实写出：目标文件存在且内容等于来源
      expect(await fs.readFile(targetFilePath, "utf8")).toBe(content);
      // 来源零写入
      expect(await fs.readFile(sourceFilePath, "utf8")).toBe(content);
    } finally {
      await application.shutdown();
    }
  });

  it("② 默认装配下**保管库**仍读不到（受控端口的两道闸门对有效授权同样生效）", async () => {
    /**
     * 本用例证明"默认可用"没有牺牲安全性：即使授权范围覆盖，
     * 受保护存储也必须被拒 —— 因为默认端口带 `ProtectedStoragePolicy`。
     */
    const vaultDirectory = path.join(sourceProjectRoot, ".astarray", "backup-vault");
    const vaultFile = path.join(vaultDirectory, "secret-backup.json");
    const secretContent = "vault-should-not-leak-through-sdk";
    await fs.mkdir(vaultDirectory, { recursive: true });
    await fs.writeFile(vaultFile, secretContent, "utf8");

    const application = await createApplicationWithoutInjectedPort();
    try {
      // 授权范围**故意**覆盖到保管库路径
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "auth-vault",
        sourceProjectIdentifier: SOURCE_PROJECT,
        sourceProjectRevision: 3,
        targetProjectIdentifier: TARGET_PROJECT,
        operationKind: "read",
        resourcePathPrefixes: [".astarray/"],
        argumentsHash: "hash-vault",
      });

      const result = await application.readCrossProjectResource({
        authorizationIdentifier: "auth-vault",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: ".astarray/backup-vault/secret-backup.json",
        absoluteResourcePath: vaultFile,
        sourceProjectRootPath: sourceProjectRoot,
        argumentsHash: "hash-vault",
      });

      expect(result.outcome).not.toBe("read-allowed");
      expect(result.didRead).toBe(false);
      // 反证"没读到"：文件确实存在且有内容
      expect(await fs.readFile(vaultFile, "utf8")).toBe(secretContent);
    } finally {
      await application.shutdown();
    }
  });

  it("③ 【如实记录已知边界】保管库保护以**单一状态目录**为界：状态目录不在该项目根内时保护不到", async () => {
    /**
     * ## 这条用例为什么存在（不是及格线，是**边界记录**）
     *
     * ② 之所以能挡住保管库，是因为 `ProtectedStoragePolicy` 按 `stateDirectoryPath` 构造，
     * 而**装配层只有一个状态目录**（`public-sdk.ts` 的
     * `getCrossProjectTransferService()` 用 `this.stateDirectory`）。
     *
     * ⇒ **已知边界**：若被借阅项目的保管库**不在**该状态目录之下
     * （例如状态目录是 `<base>/state-outside-project`，而项目保管库在
     * `<base>/project-a/.astarray/backup-vault`），该保管库**不被这条保护覆盖**。
     *
     * 本用例把边界**固定成可执行记录**：将来若把保护扩展到"每个项目根的 .astarray"，
     * 本用例会**变红**（提示更新记录），而不是让边界悄悄留在文档之外。
     */
    const vaultDirectory = path.join(sourceProjectRoot, ".astarray", "backup-vault");
    const vaultFile = path.join(vaultDirectory, "secret-backup.json");
    await fs.mkdir(vaultDirectory, { recursive: true });
    await fs.writeFile(vaultFile, "vault-bytes", "utf8");

    // 状态目录**刻意**放在项目根之外
    const application = await AstarrayApplicationFacade.create({
      stateDirectory: path.join(baseDirectory, "state-outside-project"),
      workspaceRootPath: workspaceRoot,
      mode: "assist",
      runtime: "mock",
      concurrency: 2,
      failureThreshold: 3,
    } as never);
    try {
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "auth-vault-outside",
        sourceProjectIdentifier: SOURCE_PROJECT,
        sourceProjectRevision: 3,
        targetProjectIdentifier: TARGET_PROJECT,
        operationKind: "read",
        resourcePathPrefixes: [".astarray/"],
        argumentsHash: "hash-vault-outside",
      });

      const result = await application.readCrossProjectResource({
        authorizationIdentifier: "auth-vault-outside",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: ".astarray/backup-vault/secret-backup.json",
        absoluteResourcePath: vaultFile,
        sourceProjectRootPath: sourceProjectRoot,
        argumentsHash: "hash-vault-outside",
      });

      // **当前实际行为**（已登记的边界）：保护未覆盖 ⇒ 读到内容。
      // 若将来保护扩展为"覆盖各项目根的 .astarray"，此处会变红 —— 那正是更新记录的信号。
      expect(result.outcome).toBe("read-allowed");
    } finally {
      await application.shutdown();
    }
  });
});

describe("PROJECT-01-03：默认装配下人工改动守卫生效（目标已存在也能导入）", () => {
  it("④ 目标已存在且内容**与预期一致** ⇒ 允许（此前无守卫时恒拒绝）", async () => {
    const content = "# 一致内容\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    // 目标已存在，内容恰好等于来源 ⇒ 守卫应判「无人工改动」
    await fs.writeFile(targetFilePath, content, "utf8");

    const application = await createApplicationWithoutInjectedPort();
    try {
      await grantImportAuthorization(application, "hash-guard");
      const result = await application.importCrossProjectResource({
        authorizationIdentifier: "auth-import",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: "docs/spec.md",
        targetResourcePath: "docs/spec-copy.md",
        absoluteSourcePath: sourceFilePath,
        sourceProjectRootPath: sourceProjectRoot,
        absoluteTargetPath: targetFilePath,
        targetProjectRootPath: targetProjectRoot,
        sourceRevision: 3,
        argumentsHash: "hash-guard",
        nowIso: "2026-10-31T00:00:00.000Z",
      });

      // 关键：不再因「目标已存在且无守卫」而 target-stale-rejected
      expect(result.outcome).toBe("imported-copy");
      expect(await fs.readFile(targetFilePath, "utf8")).toBe(content);
    } finally {
      await application.shutdown();
    }
  });

  it("⑤ 目标已存在且**被人工改过** ⇒ 拒绝覆盖，人工字节保留", async () => {
    const content = "# 来源内容\n";
    const humanContent = "# 用户手改过，不许覆盖\n";
    await fs.writeFile(sourceFilePath, content, "utf8");
    await fs.writeFile(targetFilePath, humanContent, "utf8");

    const application = await createApplicationWithoutInjectedPort();
    try {
      await grantImportAuthorization(application, "hash-guard-human");
      const result = await application.importCrossProjectResource({
        authorizationIdentifier: "auth-import",
        sourceProjectIdentifier: SOURCE_PROJECT,
        targetProjectIdentifier: TARGET_PROJECT,
        sourceResourcePath: "docs/spec.md",
        targetResourcePath: "docs/spec-copy.md",
        absoluteSourcePath: sourceFilePath,
        sourceProjectRootPath: sourceProjectRoot,
        absoluteTargetPath: targetFilePath,
        targetProjectRootPath: targetProjectRoot,
        sourceRevision: 3,
        argumentsHash: "hash-guard-human",
        nowIso: "2026-10-31T00:00:00.000Z",
      });

      expect(result.outcome).toBe("target-stale-rejected");
      // 关键：人工字节必须**原样保留**
      expect(await fs.readFile(targetFilePath, "utf8")).toBe(humanContent);
      // 来源零写入
      expect(await fs.readFile(sourceFilePath, "utf8")).toBe(content);
    } finally {
      await application.shutdown();
    }
  });
});
