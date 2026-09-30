/**
 * 长驻入口（`gui` / `mcp serve`）运行时选择诊断报告。
 *
 * 三入口的运行时选择本身由 `runtime-selection.ts` 解析；本模块只负责把
 * **本次实际选中的运行时**写成可验收的公开诊断 JSON，供隔离安装（tarball）
 * 验收断言「受保护凭据引用被选用」，而不是只断言 `--help` 文本。
 *
 * 纪律：报告只含公开标识（运行时种类、Provider ID、模型标识、凭据**引用 ID**），
 * 不含凭据值、端点内联 secret 或响应正文；未显式给出报告路径时不产生任何副作用。
 * 覆盖既有报告前先自动备份为 `<报告>.bak`（AGENTS.md 破坏性变更规则），
 * 写入走 `writeAtomicJson`（临时文件 → rename 原子替换）。
 */
import path from "node:path";

import {
  backupExistingFile,
  writeAtomicJson,
} from "../../../core/src/infra/atomic-json.js";
import { EXIT_CODES, failWith } from "./json-output.js";

/** 只读诊断面（`AstarrayApplicationFacade.getRuntimeDiagnostics()` 的结构子集）。 */
export interface RuntimeDiagnosticsPort {
  getRuntimeDiagnostics(): {
    runtimeKind: "mock" | "provider";
    isFeedbackProcessIndependent: boolean;
    authenticatedUserSource: "explicit" | "host" | "absent";
    mainAgentInstanceId: string;
  };
}

export interface RuntimeDiagnosticsReportOptions {
  /** 报告文件路径；缺省（undefined/空串）表示不写报告。 */
  reportFilePath: string | undefined;
  /** 本次入口实际选中的运行时种类。 */
  runtimeKind: "mock" | "provider";
  /** 选中的 Provider ID（mock 运行时为 null）。 */
  providerId: string | null;
  /** 选中的模型标识（mock 运行时为 null）。 */
  modelIdentifier: string | null;
  /** 受保护凭据引用 ID（不解析内容；未使用引用时为 null）。 */
  protectedCredentialReferenceId: string | null;
  /** 已构造的应用门面（用于读取公开诊断面）。 */
  application: RuntimeDiagnosticsPort;
}

/**
 * 写入运行时选择诊断报告。写入失败即 fail-closed（退出码 1）：
 * 验收依赖该文件，静默缺失会把验收面变成假绿。
 */
export async function writeRuntimeDiagnosticsReport(
  options: RuntimeDiagnosticsReportOptions,
): Promise<void> {
  const reportFilePath = options.reportFilePath;
  if (reportFilePath === undefined || reportFilePath === "") {
    return;
  }
  const runtimeDiagnostics = options.application.getRuntimeDiagnostics();
  const report = {
    reportVersion: "RUNTIME_SELECTION_DIAGNOSTICS_V1",
    reportedAtIso: new Date().toISOString(),
    entryRuntimeKind: options.runtimeKind,
    providerId: options.providerId,
    modelIdentifier: options.modelIdentifier,
    protectedCredentialReferenceId: options.protectedCredentialReferenceId,
    runtimeDiagnostics,
  };
  try {
    const resolvedReportFilePath = path.resolve(reportFilePath);
    // 覆盖前自动备份（备份过程不经过模型）；不存在则跳过。
    await backupExistingFile(resolvedReportFilePath, resolvedReportFilePath + ".bak");
    await writeAtomicJson(resolvedReportFilePath, report);
  } catch (error) {
    failWith(
      new Error(
        `无法写入运行时诊断报告 ${String(reportFilePath)}: ${(error as Error).message}`,
      ),
      EXIT_CODES.FAILURE,
    );
  }
}
