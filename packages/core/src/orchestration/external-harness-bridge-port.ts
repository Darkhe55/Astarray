/**
 * 外部 harness 桥接端口（T07D-08 / T07D 任务卡 §6.6）。
 *
 * 冻结可选 ExternalHarnessBridgePort / MCP / A2A 桥接契约：只定义
 * 认证主体、来源、任务信封、工具映射与权限复检；本卡不要求实现
 * 所有外部框架插件。任何桥接仍必须通过 Astarray 的本地工具注册、
 * 权限、敏感禁读与备份执行入口（桥接不提供绕过）。
 */
import { z } from "zod";

/** 桥接契约 schema 版本（T07D-08 冻结）。 */
export const EXTERNAL_HARNESS_BRIDGE_SCHEMA_VERSION = 1;

/** 桥接请求（外部 harness 提交给 Astarray 的受控信封）。 */
export const externalHarnessBridgeRequestSchema = z.object({
  schemaVersion: z.literal(EXTERNAL_HARNESS_BRIDGE_SCHEMA_VERSION),
  requestIdentifier: z.string().min(1),
  /** 桥接协议（mcp | a2a | custom；外部框架名记录）。 */
  bridgeProtocol: z.string().min(1),
  /** 认证主体（外部 harness 身份；本地控制面验证）。 */
  authenticatedPrincipal: z.string().min(1),
  /** 任务来源（用户/Agent/外部 harness；不得伪装）。 */
  sourceKind: z.enum(["user", "agent", "external-harness"]),
  /** 任务信封（目标/范围/验收；与本地任务信封同构）。 */
  taskEnvelope: z.object({
    taskIdentifier: z.string().min(1),
    scopeDescription: z.string().min(1),
    acceptanceCriteria: z.string().min(1),
  }),
  /** 外部工具名 → Astarray 本地工具映射（非空；桥接必须显式映射）。 */
  toolMappings: z
    .array(
      z.object({
        externalToolName: z.string().min(1),
        mappedLocalToolName: z.string().min(1),
      }),
    )
    .min(1),
  createdAtIso: z.iso.datetime(),
});
export type ExternalHarnessBridgeRequest = z.infer<
  typeof externalHarnessBridgeRequestSchema
>;

/** 权限复检结果（桥接不绕过本地权限；每个外部工具调用执行前复检）。 */
export interface ExternalHarnessPermissionRecheck {
  isAllowed: boolean;
  deniedReason: string | null;
  /** 复检依据的本地权限 profile 引用。 */
  recheckedAgainstProfile: string;
}

/** 桥接执行端口（本地控制面实现；外部插件只实现转换层）。 */
export interface ExternalHarnessBridgePort {
  /** 校验桥接请求并返回任务接收结果（不授予权限）。 */
  acceptBridgeRequest(
    request: ExternalHarnessBridgeRequest,
  ): Promise<{ accepted: boolean; taskIdentifier: string }>;
  /** 外部工具调用前权限复检（本地规则；模型/AI 判断不构成授权依据）。 */
  recheckToolPermission(input: {
    mappedLocalToolName: string;
    requestingPrincipal: string;
  }): Promise<ExternalHarnessPermissionRecheck>;
}

/** 桥接请求合法性校验（模型不能伪造认证主体/来源）。 */
export function assertBridgeRequestValid(
  request: ExternalHarnessBridgeRequest,
): void {
  if (request.authenticatedPrincipal.trim() === "") {
    throw new Error("桥接认证主体为空（不能伪造外部身份）");
  }
  if (
    request.sourceKind === "user" &&
    !request.authenticatedPrincipal.startsWith("user:")
  ) {
    throw new Error("用户来源桥接必须绑定认证用户主体");
  }
}