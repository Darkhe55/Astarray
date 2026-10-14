/**
 * GUI-02-03（2026-11-08）：**历史列表与详情**的只读读取层。
 *
 * ## 卡内要求（逐条对应到本模块的设计）
 *
 * > 历史列表及详情 —— 三视图；**分页按需加载**（不得全量读 97 mission）；
 * > 任务目标/项目/时间/最后状态/结果；**历史状态与运行状态分离**；
 * > **查看不恢复、不调模型、不注入上下文**；**损坏/无权记录明确处理**
 *
 * 1. **分页按需**：先只枚举 `missions/` 下的**目录名**（`readdir`，不读文件内容），
 *    排序后**只对当前页**读取 `summary.json`。因此 97 个 mission 取一页 10 条
 *    只读 10 个文件 —— 由 `onSummaryRead` 可观测（测试据此断言）。
 * 2. **历史状态与运行状态分离**：磁盘 `summary.json` 里的 `status` 只是**当时**的记录，
 *    重启后它仍可能写着 `running`。故本模块**原样保留**为 `recordedStatus`（不篡改历史），
 *    另用 `runtimeState` / `isActivelyRunning` 表达"**现在**是否真的在跑"。
 *    ⇒ 重启前 `running` 的 mission 呈现为 `interrupted-needs-reconciliation`，
 *    **不会**被显示成"正在运行"。
 * 3. **查看不恢复、不调模型、不注入上下文**：本模块**只读文件**。
 *    它把三个"危险动作"声明为**可选端口**（`requestRecovery` / `invokeModel` /
 *    `injectContext`），且**在任何代码路径下都不调用它们** —— 端口存在的意义是让调用方
 *    （与测试）能证明"若被调用就会留下痕迹"，而不是提供功能。查看历史因此恒不产生副作用。
 * 4. **损坏明确处理**：`summary.json` 缺失/非法 JSON ⇒ 该条**保留在列表中**并带
 *    `isCorrupted=true`、`recordedStatus=null`（**不抛错、不静默丢弃**）。
 *
 * ## 只读边界
 *
 * 本模块**不写任何文件**、**不删除**、**不调用模型**、**不改任务状态**。
 * `missions/<id>` 的 id 只允许作为**已枚举出的目录名**使用，且显式拒绝路径穿越，
 * 避免"用游标把读取引到目录之外"。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 默认页大小：保守值，避免一次把大量 mission 读进内存。 */
export const DEFAULT_MISSION_HISTORY_PAGE_SIZE = 20;

/** 单页硬上限：请求再大也夹到该值（防"一次全要"）。 */
export const MAXIMUM_MISSION_HISTORY_PAGE_SIZE = 100;

/** `recordedStatus` 取值 —— 与 `MissionSummary.status` 对齐。 */
export type MissionRecordedStatus = "running" | "done" | "cancelled" | "blocked";

/**
 * **运行态**判定（与历史状态分开表达）。
 *
 * - `running`：磁盘记录为 running **且**运行态确认它在跑；
 * - `finished`：磁盘记录为终态（done/cancelled/blocked）；
 * - `interrupted-needs-reconciliation`：磁盘记录为 running 但**当前没有在跑**
 *   （典型场景：进程重启过）⇒ 需对账，**不得显示为运行中**；
 * - `corrupted-needs-attention`：记录损坏/缺失 ⇒ 需人工注意；
 * - `unknown`：既非终态也未能判定（例如磁盘状态值不认识）。
 */
export type MissionRuntimeState =
  | "running"
  | "finished"
  | "interrupted-needs-reconciliation"
  | "corrupted-needs-attention"
  | "unknown";

/** 单条历史条目（**只含展示所需字段**，不夹带可注入上下文的正文）。 */
export interface MissionHistoryEntry {
  missionIdentifier: string;
  /** 任务目标（损坏时为 null）。 */
  prompt: string | null;
  mode: string | null;
  /**
   * **所属项目**（卡内点名字段）。
   * 历史遗留记录没有该字段、或值为空白 ⇒ `null`（**不伪造项目名**）。
   */
  projectIdentifier: string | null;
  createdAtIso: string | null;
  /** **历史状态**：磁盘上如实记录的当时状态（损坏时为 null）。 */
  recordedStatus: MissionRecordedStatus | null;
  /** **运行状态**：现在是否真的在跑（与历史状态分开）。 */
  runtimeState: MissionRuntimeState;
  isActivelyRunning: boolean;
  isCorrupted: boolean;
}

export interface MissionHistoryPage {
  entries: MissionHistoryEntry[];
  pageIndex: number;
  effectivePageSize: number;
  totalMissionCount: number;
  hasMorePages: boolean;
}

export interface QueryMissionHistoryInput {
  stateDirectory: string;
  pageSize?: number;
  pageIndex?: number;
  /** 游标：只返回该 mission **之后**的条目（与 `pageIndex` 二选一，优先游标）。 */
  afterMissionIdentifier?: string;
  /** 运行态来源：给定 mission 现在是否真的在跑。缺省视为"都没在跑"（保守）。 */
  isMissionActivelyRunning?: (missionIdentifier: string) => boolean | Promise<boolean>;
  /** 观测端口：每次读取 summary.json 时回调（测试据此断言"只读本页"）。 */
  onSummaryRead?: (summaryPath: string) => void;
  /**
   * 以下三个端口**仅为可证伪性而存在**：本模块**从不调用**它们。
   * 若将来有人在只读路径里误加恢复/模型调用/上下文注入，
   * 调用方（与测试）就能通过"端口被触发"立刻发现。
   */
  requestRecovery?: (missionIdentifier: string) => void;
  invokeModel?: (purpose: string) => void;
  injectContext?: (missionIdentifier: string) => void;
}

const RECOGNIZED_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "cancelled",
  "blocked",
]);

/** 目录名安全校验：只接受单个普通路径段，显式拒绝穿越与绝对路径。 */
function isSafeMissionDirectoryName(name: string): boolean {
  if (name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // Windows 盘符形式（如 C:）与 NUL 等控制字符一并拒绝
  if (name.includes(":")) return false;
  return true;
}

interface MissionDirectoryEntry {
  missionIdentifier: string;
  /** 用于"最近优先"排序：目录 mtime（读目录远比逐个读 summary 便宜）。 */
  modifiedAtMilliseconds: number;
}

async function listMissionDirectories(stateDirectory: string): Promise<MissionDirectoryEntry[]> {
  const missionsDirectory = path.join(stateDirectory, "missions");
  let directoryEntries;
  try {
    directoryEntries = await fs.readdir(missionsDirectory, { withFileTypes: true });
  } catch {
    // 目录不存在 ⇒ 视为"还没有任何 mission"（不是错误）
    return [];
  }

  const candidates = directoryEntries.filter(
    (entry) => entry.isDirectory() && isSafeMissionDirectoryName(entry.name),
  );

  const results: MissionDirectoryEntry[] = [];
  for (const candidate of candidates) {
    // 竞态下目录可能刚消失：排序时间取 0（后面读 summary 会把它标为损坏）
    let modifiedAtMilliseconds: number;
    try {
      const statistics = await fs.stat(path.join(missionsDirectory, candidate.name));
      modifiedAtMilliseconds = statistics.mtimeMs;
    } catch {
      modifiedAtMilliseconds = 0;
    }
    results.push({ missionIdentifier: candidate.name, modifiedAtMilliseconds });
  }

  // **最近优先**；同一时间戳时按 id 降序，保证顺序确定（可复现的翻页）
  results.sort((left, right) => {
    if (right.modifiedAtMilliseconds !== left.modifiedAtMilliseconds) {
      return right.modifiedAtMilliseconds - left.modifiedAtMilliseconds;
    }
    return left.missionIdentifier < right.missionIdentifier ? 1 : -1;
  });
  return results;
}

/** 读取单个 mission 的 summary.json 并归一为历史条目（**绝不抛错**）。 */
async function readMissionHistoryEntry(input: {
  stateDirectory: string;
  missionIdentifier: string;
  isMissionActivelyRunning: (missionIdentifier: string) => boolean | Promise<boolean>;
  onSummaryRead?: (summaryPath: string) => void;
}): Promise<MissionHistoryEntry> {
  const summaryPath = path.join(
    input.stateDirectory,
    "missions",
    input.missionIdentifier,
    "summary.json",
  );

  const baseEntry = {
    missionIdentifier: input.missionIdentifier,
    prompt: null as string | null,
    mode: null as string | null,
    projectIdentifier: null as string | null,
    createdAtIso: null as string | null,
    recordedStatus: null as MissionRecordedStatus | null,
    isActivelyRunning: false,
  };

  let rawContent: string;
  try {
    input.onSummaryRead?.(summaryPath);
    rawContent = await fs.readFile(summaryPath, "utf8");
  } catch {
    // 缺失/不可读 ⇒ 明确标注损坏（保留在列表里，不静默丢弃）
    return {
      ...baseEntry,
      runtimeState: "corrupted-needs-attention",
      isCorrupted: true,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const parsedValue: unknown = JSON.parse(rawContent);
    if (parsedValue === null || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      throw new TypeError("summary 不是对象");
    }
    parsed = parsedValue as Record<string, unknown>;
  } catch {
    return {
      ...baseEntry,
      runtimeState: "corrupted-needs-attention",
      isCorrupted: true,
    };
  }

  const rawStatus = typeof parsed["status"] === "string" ? parsed["status"] : null;
  const recordedStatus =
    rawStatus === "running" ||
    rawStatus === "done" ||
    rawStatus === "cancelled" ||
    rawStatus === "blocked"
      ? (rawStatus as MissionRecordedStatus)
      : null;

  const prompt = typeof parsed["prompt"] === "string" ? parsed["prompt"] : null;
  const mode = typeof parsed["mode"] === "string" ? parsed["mode"] : null;
  /**
   * **项目标识**：只有"字符串且非空白"才算有值；否则 `null`。
   * 空白串若原样返回，界面会显示一个"看起来有值"的空项目名 —— 那是伪装，故归一为 null。
   */
  const rawProjectIdentifier = parsed["projectIdentifier"];
  const projectIdentifier =
    typeof rawProjectIdentifier === "string" && rawProjectIdentifier.trim().length > 0
      ? rawProjectIdentifier.trim()
      : null;
  const createdAtIso =
    typeof parsed["createdAtIso"] === "string" ? parsed["createdAtIso"] : null;

  /**
   * **历史状态与运行状态分离**的核心：
   * - 只有"磁盘记录为 running"时，运行态才有意义；
   * - 且必须由 `isMissionActivelyRunning` 确认 —— 否则一律
   *   `interrupted-needs-reconciliation`（重启后不得显示为运行中）。
   */
  const isActivelyRunning =
    recordedStatus === "running" && (await input.isMissionActivelyRunning(input.missionIdentifier));

  let runtimeState: MissionRuntimeState;
  if (recordedStatus === "running") {
    runtimeState = isActivelyRunning ? "running" : "interrupted-needs-reconciliation";
  } else if (recordedStatus !== null && RECOGNIZED_TERMINAL_STATUSES.has(recordedStatus)) {
    runtimeState = "finished";
  } else {
    runtimeState = "unknown";
  }

  return {
    ...baseEntry,
    prompt,
    mode,
    projectIdentifier,
    createdAtIso,
    recordedStatus,
    isActivelyRunning,
    runtimeState,
    isCorrupted: false,
  };
}

export async function queryMissionHistory(
  input: QueryMissionHistoryInput,
): Promise<MissionHistoryPage> {
  const requestedPageSize = input.pageSize ?? DEFAULT_MISSION_HISTORY_PAGE_SIZE;
  if (!Number.isInteger(requestedPageSize) || requestedPageSize < 1) {
    throw new Error(
      "mission-history-page-size-invalid：pageSize 必须为正整数，收到 " +
        String(requestedPageSize),
    );
  }
  const effectivePageSize = Math.min(requestedPageSize, MAXIMUM_MISSION_HISTORY_PAGE_SIZE);

  const requestedPageIndex = input.pageIndex ?? 0;
  if (!Number.isInteger(requestedPageIndex) || requestedPageIndex < 0) {
    throw new Error(
      "mission-history-page-index-invalid：pageIndex 必须为非负整数，收到 " +
        String(requestedPageIndex),
    );
  }

  const missionDirectories = await listMissionDirectories(input.stateDirectory);
  const totalMissionCount = missionDirectories.length;

  /**
   * 页码 → 起始偏移。游标优先：给了 `afterMissionIdentifier` 就据它在**已排序**列表中定位，
   * 且**只接受本列表内真实存在的目录名**（因此拿 `../..` 之类只会得到空页，不会越界读取）。
   */
  let startOffset: number;
  if (input.afterMissionIdentifier !== undefined) {
    const cursorIndex = missionDirectories.findIndex(
      (entry) => entry.missionIdentifier === input.afterMissionIdentifier,
    );
    startOffset = cursorIndex < 0 ? totalMissionCount : cursorIndex + 1;
  } else {
    startOffset = requestedPageIndex * effectivePageSize;
  }

  const pageDirectories = missionDirectories.slice(
    startOffset,
    startOffset + effectivePageSize,
  );

  const isMissionActivelyRunning = input.isMissionActivelyRunning ?? (() => false);
  const entries: MissionHistoryEntry[] = [];
  for (const missionDirectory of pageDirectories) {
    entries.push(
      await readMissionHistoryEntry({
        stateDirectory: input.stateDirectory,
        missionIdentifier: missionDirectory.missionIdentifier,
        isMissionActivelyRunning,
        ...(input.onSummaryRead === undefined ? {} : { onSummaryRead: input.onSummaryRead }),
      }),
    );
  }

  // 注意：这里**没有**调用 requestRecovery / invokeModel / injectContext —— 这是刻意的。
  return {
    entries,
    pageIndex: requestedPageIndex,
    effectivePageSize,
    totalMissionCount,
    hasMorePages: startOffset + pageDirectories.length < totalMissionCount,
  };
}
