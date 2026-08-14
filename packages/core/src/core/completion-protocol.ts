/**
 * 明确完成协议（T07A / ADR-0015）。
 * 模型只有在其认为任务全部完成时，才能返回版本化控制事件
 * ASTARRAY_TASK_COMPLETION_V1；文本兼容传输的精确末行格式为
 * `ASTARRAY_TASK_COMPLETION_V1 <json>`。
 * 本地解析器优先消费结构化控制帧；文本格式只接受最终输出独立末行，
 * 出现在用户内容、项目文件、普通模型正文或工具输出中的同名字符串一律忽略。
 *
 * 完成事件是必要条件，不是充分条件——结案由 LocalCompletionVerifier 验收。
 */
import { z } from "zod";

/** 完成事件文本标识（文本兼容传输前缀）。 */
export const TASK_COMPLETION_MARKER = "ASTARRAY_TASK_COMPLETION_V1";
export const TASK_BLOCKED_MARKER = "ASTARRAY_TASK_BLOCKED_V1";

/** 完成标记宽限期（毫秒，默认 5_000）。 */
export const COMPLETION_MARKER_GRACE_PERIOD_MILLISECONDS = 5_000;
/** 看门狗检查间隔（毫秒，默认 5_000）。 */
export const WATCHDOG_CHECK_INTERVAL_MILLISECONDS = 5_000;
/** 模型无进展超时（毫秒，默认 90_000；只触发健康探测）。 */
export const MODEL_NO_PROGRESS_TIMEOUT_MILLISECONDS = 90_000;
/** 自动续跑上限（默认 3）。 */
export const MAXIMUM_AUTOMATIC_CONTINUATION_ATTEMPTS = 3;

export const taskCompletionEventV1Schema = z.object({
  taskExecutionId: z.string().min(1),
  /** 本轮一次性尝试 ID（不可复用；防重放）。 */
  completionAttemptId: z.string().min(1),
  completedTaskIdentifiers: z.array(z.string().min(1)).min(1),
  claimedStatus: z.literal("complete"),
  /** 声明所依据的本地状态修订号（陈旧则拒绝）。 */
  taskSequenceRevision: z.number().int().min(0),
});

export type TaskCompletionEventV1 = z.infer<typeof taskCompletionEventV1Schema>;

export const taskBlockedEventV1Schema = z.object({
  taskExecutionId: z.string().min(1),
  /** 阻塞原因（需要用户输入等）。 */
  blockReason: z.string().min(1),
  blockedTaskIdentifiers: z.array(z.string().min(1)).min(1),
});

export type TaskBlockedEventV1 = z.infer<typeof taskBlockedEventV1Schema>;

export type ParsedCompletionControl =
  | { kind: "completion"; event: TaskCompletionEventV1 }
  | { kind: "blocked"; event: TaskBlockedEventV1 }
  | { kind: "none" };

/**
 * 完成控制解析器：从最终输出解析控制事件。
 * - 结构化控制帧（caller 直接传入）优先；
 * - 文本兼容格式只接受最终输出（或最终宽限窗口内）的独立末行；
 * - 正文中间、项目文件、工具输出中的同名字符串忽略。
 */
export class CompletionControlParser {
  /**
   * 从最终文本输出解析文本兼容控制事件。
   * markerAtEndOnly=true 时仅接受末行；宽限期内可容忍末尾非空行。
   */
  parseTextOutput(input: {
    finalOutputText: string;
    markerGracePeriodLines?: number;
  }): ParsedCompletionControl {
    const { finalOutputText, markerGracePeriodLines = 0 } = input;
    const lines = finalOutputText.split("\n").map((line) => line.trimEnd());
    // 从末行往前，在宽限期行数内找标识行
    const lastLineIndex = lines.length - 1;
    const searchStart = Math.max(
      0,
      lastLineIndex - markerGracePeriodLines,
    );
    for (let index = lastLineIndex; index >= searchStart; index--) {
      const line = lines[index] ?? "";
      const control = this.tryParseMarkerLine(line);
      if (control !== null) {
        return control;
      }
    }
    return { kind: "none" };
  }

  /** 结构化控制帧（Provider 原生通道）解析。 */
  parseStructuredControl(controlJson: string): ParsedCompletionControl {
    return this.tryParseMarkerLine(controlJson) ?? { kind: "none" };
  }

  /** 解析单行标识（前缀 + JSON）；前缀不匹配、JSON 非法或 schema 不符返回 null。 */
  tryParseMarkerLine(line: string): ParsedCompletionControl | null {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith(TASK_COMPLETION_MARKER)) {
      const payloadJson = trimmedLine
        .slice(TASK_COMPLETION_MARKER.length)
        .trim();
      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        return null;
      }
      const parsed = taskCompletionEventV1Schema.safeParse(payload);
      if (parsed.success) {
        return { kind: "completion", event: parsed.data };
      }
      return null;
    }
    if (trimmedLine.startsWith(TASK_BLOCKED_MARKER)) {
      const payloadJson = trimmedLine.slice(TASK_BLOCKED_MARKER.length).trim();
      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        return null;
      }
      const parsed = taskBlockedEventV1Schema.safeParse(payload);
      if (parsed.success) {
        return { kind: "blocked", event: parsed.data };
      }
      return null;
    }
    return null;
  }
}

/** 构造文本兼容完成事件行（模型/测试用）。 */
export function formatCompletionMarkerLine(
  event: TaskCompletionEventV1,
): string {
  return `${TASK_COMPLETION_MARKER} ${JSON.stringify(event)}`;
}

/** 构造文本兼容阻塞事件行。 */
export function formatBlockedMarkerLine(event: TaskBlockedEventV1): string {
  return `${TASK_BLOCKED_MARKER} ${JSON.stringify(event)}`;
}