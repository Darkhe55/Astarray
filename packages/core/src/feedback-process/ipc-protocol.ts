/**
 * 独立反馈进程的 IPC 协议（T04）。
 * 显式版本化协议，业务消息不经过 stdout（stdout/stderr 只作诊断日志）。
 * 所有消息必须携带 protocolVersion 与 requestId（指令类）。
 */
import type { AgentStatus, FeedbackMessage, TransportHealth } from "../core/types.js";
import { FEEDBACK_PROTOCOL_VERSION } from "../core/types.js";

export type FeedbackIpcMessage =
  | {
      type: "hello";
      protocolVersion: number;
      baseDirectory: string;
      heartbeatTimeoutMilliseconds: number;
    }
  | {
      type: "enqueue";
      requestId: string;
      message: FeedbackMessage;
    }
  | {
      type: "setAgentStatus";
      recipientId: string;
      status: AgentStatus;
    }
  | {
      type: "ackDelivered";
      requestId: string;
      messageId: string;
    }
  | {
      type: "health";
      requestId: string;
    }
  | {
      type: "replay";
      requestId: string;
      recipientId: string;
    }
  | {
      type: "shutdown";
      requestId: string;
    }
  | {
      type: "heartbeat";
      timestampUnixMilliseconds: number;
    }
  | {
      type: "ready";
      protocolVersion: number;
      processPid: number;
    }
  | {
      type: "enqueued";
      requestId: string;
      accepted: boolean;
    }
  | {
      type: "deliver";
      message: FeedbackMessage;
    }
  | {
      type: "acked";
      requestId: string;
    }
  | {
      type: "healthResult";
      requestId: string;
      health: TransportHealth;
    }
  | {
      type: "replayResult";
      requestId: string;
      replayCount: number;
    }
  | {
      type: "shutdownComplete";
      requestId: string;
    }
  | {
      type: "protocolError";
      requestId: string | null;
      errorCode: string;
      errorMessage: string;
    };

export { FEEDBACK_PROTOCOL_VERSION };

export function isProtocolVersionSupported(
  actualVersion: number,
): boolean {
  return actualVersion === FEEDBACK_PROTOCOL_VERSION;
}
