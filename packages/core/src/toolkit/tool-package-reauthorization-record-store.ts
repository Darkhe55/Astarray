/**
 * TOOLKIT-01-04：**重新授权记录**原语（2026-10-13）。
 *
 * 为什么需要它（实测缺口）：版本升级的"新增副作用须重新授权"门禁，此前最终只依赖
 * `upgradeProjectVersion({ isReauthorized: true })` 这个**调用方自述的裸布尔值**
 * ⇒ 任何调用方（含 CLI 的 `--reauthorized`）只要传 true 就能完成切换。
 * 同一控制器在 `enableForProject` 处已明确把这种形态判定为"旁路"并移除了该参数，
 * 但**唯一**的切换入口 `upgradeProjectVersion()` 恰恰就是这个形态。
 *
 * 本原语把授权依据换成**可核验的本地记录**：
 *  - 记录**绑定**到本次操作（项目 / 工具包 / from→to / **新增副作用逐项** / 签发者）；
 *  - 由**本地受控流程**签发（人显式确认升级差异后才签发），因此不是调用方的断言；
 *  - **一次性**：消费后即失效，避免"一次批准反复升级"。
 *
 * 被否决的两种"省事"做法（勿重走）：
 *  ① 让调用方自己算差异指纹 —— 仍是调用方断言，只是把"顺手 true"换成"顺手算哈希"；
 *  ② 只在 CLI 加确认交互 —— 绕过 CLI 直调 SDK 仍可放行，且门禁必须落在**服务端**。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface ToolPackageReauthorizationScope {
  projectIdentifier: string;
  toolPackageId: string;
  fromVersion: number;
  toVersion: number;
  /** 本次升级**新增的副作用**（签发时由差异判定得出；顺序不敏感）。 */
  addedSideEffects: string[];
}

export interface ToolPackageReauthorizationRecord extends ToolPackageReauthorizationScope {
  recordIdentifier: string;
  /** 绑定指纹（对 scope 的规范化内容取 sha256，顺序不敏感）。 */
  scopeFingerprint: string;
  /** 签发者（本地受控流程/人员标识）。 */
  issuedBy: string;
  issuedAtIso: string;
  /** 已被消费的时间；非 null 即不可再用。 */
  consumedAtIso: string | null;
}

export interface ToolPackageReauthorizationConsumeOutcome {
  isConsumed: boolean;
  reason: string | null;
}

/**
 * scope 的规范化指纹：字段顺序固定 + 副作用**排序后**参与 ⇒
 * "同一批副作用的不同排列"视为同一 scope（避免因顺序差异误拒），
 * 而任何字段不同都会改变指纹。
 */
export function computeReauthorizationScopeFingerprint(
  scope: ToolPackageReauthorizationScope,
): string {
  const canonicalText = [
    "project=" + scope.projectIdentifier,
    "toolPackage=" + scope.toolPackageId,
    "from=" + String(scope.fromVersion),
    "to=" + String(scope.toVersion),
    "addedSideEffects=" + [...scope.addedSideEffects].sort().join(","),
  ].join("\n");
  return "sha256:" + createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

export class ToolPackageReauthorizationRecordStore {
  private readonly recordsFilePath: string;

  constructor(options: { stateDirectory: string }) {
    this.recordsFilePath = path.join(
      options.stateDirectory,
      "tool-package-reauthorizations.json",
    );
  }

  /** 签发一条记录（本地受控流程调用；**不是**给模型调用的工具）。 */
  async issueRecord(input: {
    scope: ToolPackageReauthorizationScope;
    issuedBy: string;
  }): Promise<ToolPackageReauthorizationRecord> {
    const records = await this.readRecords();
    const record: ToolPackageReauthorizationRecord = {
      ...input.scope,
      recordIdentifier: randomUUID(),
      scopeFingerprint: computeReauthorizationScopeFingerprint(input.scope),
      issuedBy: input.issuedBy,
      issuedAtIso: new Date().toISOString(),
      consumedAtIso: null,
    };
    records.push(record);
    await this.writeRecords(records);
    return record;
  }

  async listRecords(): Promise<ToolPackageReauthorizationRecord[]> {
    return this.readRecords();
  }

  /**
   * 核验并**一次性消费**：记录必须存在、**未被消费**、且绑定字段与本次待执行的操作
   * **逐项一致**；否则一律拒绝（不抛错，返回可读理由，便于入口如实回报）。
   */
  async consumeRecordForOperation(input: {
    recordIdentifier: string;
    scope: ToolPackageReauthorizationScope;
  }): Promise<ToolPackageReauthorizationConsumeOutcome> {
    const records = await this.readRecords();
    const index = records.findIndex(
      (record) => record.recordIdentifier === input.recordIdentifier,
    );
    if (index === -1) {
      return {
        isConsumed: false,
        reason: "重新授权记录不存在（不得凭自述放行）",
      };
    }
    const record = records[index]!;
    if (record.consumedAtIso !== null) {
      return {
        isConsumed: false,
        reason: "重新授权记录已被使用过（一次性，须重新取得授权）",
      };
    }
    const expectedFingerprint = computeReauthorizationScopeFingerprint(input.scope);
    if (record.scopeFingerprint !== expectedFingerprint) {
      return {
        isConsumed: false,
        reason:
          "重新授权记录与本次操作不匹配（绑定范围不同）：" +
          `记录=${record.scopeFingerprint.slice(0, 18)}… 本次=${expectedFingerprint.slice(0, 18)}…`,
      };
    }
    records[index] = { ...record, consumedAtIso: new Date().toISOString() };
    await this.writeRecords(records);
    return { isConsumed: true, reason: null };
  }

  private async readRecords(): Promise<ToolPackageReauthorizationRecord[]> {
    try {
      const rawText = await fs.readFile(this.recordsFilePath, "utf8");
      const parsed = JSON.parse(rawText) as { records?: unknown };
      if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.records)) {
        return [];
      }
      return parsed.records as ToolPackageReauthorizationRecord[];
    } catch {
      // 文件不存在或损坏 ⇒ 视为"没有任何有效授权"（fail-closed），不抛错。
      return [];
    }
  }

  private async writeRecords(records: ToolPackageReauthorizationRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.recordsFilePath), { recursive: true });
    await fs.writeFile(
      this.recordsFilePath,
      JSON.stringify({ records }, null, 2) + "\n",
      "utf8",
    );
  }
}
