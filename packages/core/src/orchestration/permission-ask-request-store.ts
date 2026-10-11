/**
 * 权限询问的**请求实体**：登记、持久化、状态迁移与裁决校验。
 *
 * **2026-10-11 新增（GUI-02-01，用户决策）**。动机：提取后核实发现
 * permission-ask 只有"问一次答一次"的 `PermissionAsk`（4 个字段），
 * **没有请求实体** —— 没有身份、没有请求自身状态、没有 revision、没有有效期。因此：
 *
 * - **N3「过期裁决被拒」没有可测载体**；
 * - **N1「同一请求经 CLI／GUI 裁决结果一致」没有"同一请求"这个概念**；
 * - S3 要求的"绑定**完整参数指纹** + revision""**过期/撤销不得复用**"无处落地；
 * - 多页面同步与**拒绝陈旧裁决**没有锚点。
 *
 * 本模块提供该实体，遵循用户 2026-10-11 的边界：
 *
 * | 要求（用户原文） | 本模块的落法 |
 * | --- | --- |
 * | 裁决入口接收**请求 ID、决定及预期 revision／指纹** | `decideRequest` 入参**只有**这四项 + 裁决者身份与裁决权；**没有**参数入参 |
 * | 服务器从**本地权威记录**取原始参数 | 判定与返回一律读盘上记录；`argumentsJson` **只在登记时写入一次** |
 * | **不得接受前端提交的新参数替换原请求** | 入参无参数位；用例 ④ 断言裁决后原文**逐字不变** |
 * | **不得把知道请求 ID 或指纹当作有权批准** | 需显式 `hasAdjudicationAuthority`；用例 ⑧ |
 * | 重新校验**主体、权限、期限和当前状态** | 逐项校验：裁决权 / 状态 / 期限 / revision / 指纹 |
 *
 * **指纹**：复用 `hashToolArguments`（`core/permission-policy.ts`）——
 * 它先做**递归键序规范化**再 sha256，故：
 * **内容变化 ⇒ 指纹变化**（S3 要求），**仅键序不同 ⇒ 同一指纹**（保留 2026-10-02
 * 方案 B 对"无副作用重试格式抖动"的容忍）。
 * 前缀 `sha256:` 由本模块补齐（`hashToolArguments` 返回裸 hex）。
 *
 * **依赖方向**：仅依赖 core 内部（`atomic-json`、`errors`、`permission-policy`、
 * `work-archive-store` 的 `sanitizePathSegment`）；**不依赖任何界面层或终端**。
 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { hashToolArguments } from "../core/permission-policy.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import { sanitizePathSegment } from "./work-archive-store.js";

/** 请求生命周期状态。**只有 `pending` 可裁决**。 */
export type PermissionAskRequestStatus =
  | "pending"
  | "allowed"
  | "denied"
  | "expired"
  | "revoked";

export interface PermissionAskRequestRecord {
  askIdentifier: string;
  ownerAgentInstanceId: string;
  taskIdentifier: string;
  toolName: string;
  /**
   * **本地权威原始参数**：登记时写入一次，**裁决不得改动**
   * （授权按参数哈希绑定；不得改写、不得截断）。
   */
  argumentsJson: string;
  explanation: string;
  /** 绑定**完整规范化参数**的指纹（`sha256:` + hex）。 */
  operationFingerprint: string;
  status: PermissionAskRequestStatus;
  /** 请求自身的 revision；**每次状态迁移递增**（多页面同步与拒绝陈旧裁决的锚点）。 */
  requestRevision: number;
  createdAtIso: string;
  expiresAtIso: string;
  decidedAtIso: string | null;
  decidedByAgentInstanceId: string | null;
}

/** 默认有效期（秒）：给用户足够时间看清并裁决，但不会无限期悬挂。 */
export const DEFAULT_PERMISSION_ASK_LIFETIME_SECONDS = 15 * 60;

export interface PermissionAskRequestStoreOptions {
  baseDirectory: string;
  /** 测试注入的时钟。 */
  nowMilliseconds?: () => number;
}

export class PermissionAskRequestStore {
  private readonly baseDirectory: string;
  private readonly nowMilliseconds: () => number;

  constructor(options: PermissionAskRequestStoreOptions) {
    this.baseDirectory = options.baseDirectory;
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  /** 登记一次权限询问，返回**权威记录**（含身份与指纹）。 */
  async registerRequest(input: {
    ownerAgentInstanceId: string;
    taskIdentifier: string;
    toolName: string;
    /** 精确参数：**逐字保留**（不得改写、不得截断）。 */
    argumentsJson: string;
    explanation: string;
    lifetimeSeconds?: number;
    askIdentifier?: string;
  }): Promise<PermissionAskRequestRecord> {
    const nowMilliseconds = this.nowMilliseconds();
    const lifetimeSeconds =
      input.lifetimeSeconds ?? DEFAULT_PERMISSION_ASK_LIFETIME_SECONDS;
    if (!(lifetimeSeconds >= 0)) {
      throw new DomainError(
        "permission-ask-invalid",
        "有效期必须为非负数秒: " + String(lifetimeSeconds),
      );
    }
    const askIdentifier =
      input.askIdentifier ??
      "ask-" + nowMilliseconds.toString(36) + "-" + Math.abs(hashNumber(input.argumentsJson)).toString(36);
    const record: PermissionAskRequestRecord = {
      askIdentifier,
      ownerAgentInstanceId: input.ownerAgentInstanceId,
      taskIdentifier: input.taskIdentifier,
      toolName: input.toolName,
      argumentsJson: input.argumentsJson,
      explanation: input.explanation,
      operationFingerprint: "sha256:" + hashToolArguments(input.argumentsJson),
      status: "pending",
      requestRevision: 1,
      createdAtIso: new Date(nowMilliseconds).toISOString(),
      expiresAtIso: new Date(nowMilliseconds + lifetimeSeconds * 1_000).toISOString(),
      decidedAtIso: null,
      decidedByAgentInstanceId: null,
    };
    await writeAtomicJson(this.requestFilePath(record), record);
    return record;
  }

  /** 读取单个请求（不存在返回 null）。**这是裁决的唯一事实来源。** */
  async readRequest(
    askIdentifier: string,
  ): Promise<PermissionAskRequestRecord | null> {
    const filePath = await this.requestFilePathByIdentifier(askIdentifier);
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return JSON.parse(rawContent) as PermissionAskRequestRecord;
  }

  /**
   * 裁决请求。
   *
   * 入参**只有**：请求 ID、决定、预期 revision、预期指纹、裁决者身份、是否有裁决权。
   * **没有参数位** —— 参数只能来自本地权威记录（用户明确要求）。
   *
   * 校验顺序（任一失败即拒绝，且**不改动记录**，除"过期"需落 `expired` 终态）：
   * ① 请求存在；② 有裁决权；③ 未过期；④ 仍为 `pending`；⑤ revision 匹配；⑥ 指纹匹配。
   */
  async decideRequest(input: {
    askIdentifier: string;
    decision: "allowed-once" | "denied";
    expectedRequestRevision: number;
    expectedOperationFingerprint: string;
    deciderAgentInstanceId: string;
    hasAdjudicationAuthority: boolean;
  }): Promise<PermissionAskRequestRecord> {
    const record = await this.readRequest(input.askIdentifier);
    if (record === null) {
      throw new DomainError(
        "permission-ask-not-found",
        "未登记的权限询问请求: " + input.askIdentifier,
      );
    }
    if (!input.hasAdjudicationAuthority) {
      // 知道 ID 与指纹**不构成**批准权。
      throw new DomainError(
        "permission-ask-not-authorized",
        "裁决者无裁决权，拒绝裁决: " + input.deciderAgentInstanceId,
      );
    }
    if (Date.parse(record.expiresAtIso) <= this.nowMilliseconds()) {
      if (record.status === "pending") {
        await writeAtomicJson(this.requestFilePath(record), {
          ...record,
          status: "expired",
          requestRevision: record.requestRevision + 1,
        } satisfies PermissionAskRequestRecord);
      }
      throw new DomainError(
        "permission-ask-expired",
        "权限询问已过期，不得复用批准: " + input.askIdentifier,
      );
    }
    if (record.status !== "pending") {
      throw new DomainError(
        "permission-ask-already-decided",
        "请求已裁决，不得重复裁决: " + record.status,
      );
    }
    if (record.requestRevision !== input.expectedRequestRevision) {
      throw new DomainError(
        "permission-ask-stale-revision",
        "请求 revision 已前进，拒绝陈旧裁决: " +
          String(input.expectedRequestRevision) +
          " != " +
          String(record.requestRevision),
      );
    }
    if (record.operationFingerprint !== input.expectedOperationFingerprint) {
      throw new DomainError(
        "permission-ask-fingerprint-mismatch",
        "操作指纹不匹配，拒绝裁决（参数变化不得复用批准）",
      );
    }
    const decided: PermissionAskRequestRecord = {
      ...record,
      status: input.decision === "allowed-once" ? "allowed" : "denied",
      requestRevision: record.requestRevision + 1,
      decidedAtIso: new Date(this.nowMilliseconds()).toISOString(),
      decidedByAgentInstanceId: input.deciderAgentInstanceId,
    };
    await writeAtomicJson(this.requestFilePath(decided), decided);
    return decided;
  }

  private requestDirectoryPath(ownerAgentInstanceId: string): string {
    return path.join(
      this.baseDirectory,
      "agent-memory",
      sanitizePathSegment(ownerAgentInstanceId),
      "permission-ask-requests",
    );
  }

  private requestFilePath(record: PermissionAskRequestRecord): string {
    return path.join(
      this.requestDirectoryPath(record.ownerAgentInstanceId),
      sanitizePathSegment(record.askIdentifier) + ".json",
    );
  }

  /**
   * 按 askIdentifier 定位文件。
   *
   * 说明：`askIdentifier` 在**全局**范围内唯一（登记时生成），但磁盘布局按 owner 分层。
   * 由于裁决入口只拿到 `askIdentifier`，这里扫描各 owner 目录定位（只做只读定位，
   * 扫描的是**本状态目录**下 agent-memory 里每个 owner 的 permission-ask-requests 子目录）。
   */
  private async requestFilePathByIdentifier(
    askIdentifier: string,
  ): Promise<string> {
    const agentMemoryRoot = path.join(this.baseDirectory, "agent-memory");;
    const fileName = sanitizePathSegment(askIdentifier) + ".json";
    let ownerEntries: Dirent[];
    try {
      ownerEntries = await fs.readdir(agentMemoryRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return path.join(agentMemoryRoot, "_", "permission-ask-requests", fileName);
      }
      throw error;
    }
    for (const ownerEntry of ownerEntries) {
      if (!ownerEntry.isDirectory()) {
        continue;
      }
      const candidate = path.join(
        agentMemoryRoot,
        ownerEntry.name,
        "permission-ask-requests",
        fileName,
      );
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    // 未找到：返回名义路径，由 readRequest 统一按 ENOENT 处理为 null。
    return path.join(agentMemoryRoot, "_", "permission-ask-requests", fileName);
  }
}

/** 仅供 askIdentifier 生成使用的稳定数值（**不是**安全哈希）。 */
function hashNumber(value: string): number {
  let accumulated = 0;
  for (const character of value) {
    accumulated = (accumulated * 31 + character.codePointAt(0)!) | 0;
  }
  return accumulated;
}
