/**
 * 任务链总调用预算**持久化账本**（2026-11-08，第 162 轮）。
 *
 * ## 为什么需要它（卡与 ADR）
 *
 * - ADR-0017「工具反自指与活锁保护」：任务总调用预算**持久化、进程重启不清零**；
 * - `docs/tasks/T07E_AGENT_WORKING_SET_READ_BUDGET_TASK_CARD.md` **L27**：
 *   「新建 Agent、模型切换、Provider 切换、**早停续跑、进程重启**和 handoff
 *   **不能清零任务链累计预算**」；**L82（T07E-04）** 验收「新身份/续跑不清零」。
 *
 * 而 `LocalProgressAndCycleGuard` 的 `readTaskBudget`/`writeTaskBudget` 端口
 * 在装配时**没有接**（缺省 `() => 0` / `() => {}`）⇒ 计数只活在内存里，
 * 第 161 轮实测：**重启后又能跑 17 次**（预算被清零）。
 *
 * ## 设计要点
 *
 * - **按任务链**（`taskExecutionId`）计数，不是按 Agent ⇒ 新 Agent／新身份不清零 ✓；
 * - **同步**接口：守卫的两个端口是同步签名，故用 `writeFileSync` + `renameSync`
 *   （同卷原子替换）保证"要么旧值、要么新值"，不会写出半截文件；
 * - **失败不阻塞业务**：读失败 ⇒ 返回 0（退化到进程内计数，宁可少拦也不能拖垮任务）；
 *   写失败 ⇒ 吞掉异常（调用方是确定性守卫，不得因磁盘问题让业务失败）；
 * - 文件放在 `stateDirectory/task-call-budgets/<安全化 id>.json`，与其它状态同域。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TaskCallBudgetLedgerOptions {
  /** 状态目录（与任务存储同域）。 */
  stateDirectory: string;
}

interface TaskCallBudgetRecord {
  taskExecutionId: string;
  callCount: number;
}

export class TaskCallBudgetLedger {
  private readonly directory: string;

  constructor(options: TaskCallBudgetLedgerOptions) {
    this.directory = path.join(options.stateDirectory, "task-call-budgets");
    try {
      mkdirSync(this.directory, { recursive: true });
    } catch {
      // 目录建不出来时不阻塞业务：读写都会退化（读 0 / 写丢弃）。
    }
  }

  /**
   * 读取某任务链已消耗的调用数。
   * **读失败一律返回 0**（退化为进程内计数）：宁可少拦一次，也不能让任务因磁盘问题失败。
   */
  readTaskCallCount(taskExecutionId: string): number {
    try {
      const record = JSON.parse(
        readFileSync(this.resolveRecordPath(taskExecutionId), "utf8"),
      ) as TaskCallBudgetRecord;
      const callCount = record.callCount;
      return typeof callCount === "number" && Number.isFinite(callCount) && callCount >= 0
        ? Math.floor(callCount)
        : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 写入某任务链的累计调用数（原子替换）。**写失败吞掉异常**：守卫不得因磁盘问题拖垮业务。
   */
  writeTaskCallCount(taskExecutionId: string, callCount: number): void {
    try {
      const recordPath = this.resolveRecordPath(taskExecutionId);
      const temporaryPath = recordPath + ".tmp-" + String(process.pid);
      const record: TaskCallBudgetRecord = { taskExecutionId, callCount: Math.floor(callCount) };
      writeFileSync(temporaryPath, JSON.stringify(record), "utf8");
      renameSync(temporaryPath, recordPath);
    } catch {
      // 写失败不影响业务（下一轮 read 会退化到 0，即"少拦"，不会误杀任务）
    }
  }

  /** 记录文件路径：id 做安全化，避免路径穿越与非法字符。 */
  private resolveRecordPath(taskExecutionId: string): string {
    const safeName = taskExecutionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    return path.join(this.directory, safeName + ".json");
  }
}
