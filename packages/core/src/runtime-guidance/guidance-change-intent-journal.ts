/**
 * GUIDE 增量：指导变更意图状态日志（跨进程 CLI history/revision 共用）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";
import type { GuidanceChangeIntentState } from "./guidance-change-intent.js";

export class FileGuidanceChangeIntentJournal {
  private readonly filePath: string;

  constructor(options: { baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "guidance", "change-intent.json");
  }

  async read(): Promise<GuidanceChangeIntentState | null> {
    try {
      const rawContent = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(rawContent) as GuidanceChangeIntentState;
      return parsed.schemaVersion === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(state: GuidanceChangeIntentState): Promise<void> {
    await writeAtomicJson(this.filePath, state);
  }
}
