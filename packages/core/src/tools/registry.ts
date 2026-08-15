/**
 * 工具注册表（T06）。
 * 主 Agent 只获得预览（名称+摘要）；次级 Agent 获得完整描述；
 * 三级 Agent 只获得任务所需工具子集。
 * shell、删除、安装、发布、付款类工具默认不注册（未注册 = 不可调用）。
 */
import type {
  ToolDescriptor,
  ToolDescriptorPreview,
} from "../core/types.js";
import { DESTRUCTIVE_TOOL_MUTATION_KINDS } from "../core/types.js";
import { PermissionCapabilityCatalog } from "./permission-capability-catalog.js";

export class ToolRegistry {
  private readonly descriptorsByName = new Map<string, ToolDescriptor>();
  /** T06F：权限目录（工具注册校验；未映射工具拒绝注册/执行）。 */
  private readonly capabilityCatalog: PermissionCapabilityCatalog;

  constructor(capabilityCatalog?: PermissionCapabilityCatalog) {
    this.capabilityCatalog = capabilityCatalog ?? new PermissionCapabilityCatalog();
  }

  register(descriptor: ToolDescriptor): void {
    if (this.descriptorsByName.has(descriptor.name)) {
      throw new Error(`工具重复注册: ${descriptor.name}`);
    }
    // T06F：未映射任何可配置权限的工具拒绝注册（未分类工具拒绝执行）
    this.capabilityCatalog.assertToolMapped(descriptor);
    if (
      DESTRUCTIVE_TOOL_MUTATION_KINDS.includes(
        descriptor.mutationKind as (typeof DESTRUCTIVE_TOOL_MUTATION_KINDS)[number],
      ) &&
      descriptor.mutationKind !== "delete-protected-backup" &&
      descriptor.backupPolicy !== "automatic-preimage"
    ) {
      throw new Error(`破坏性工具未提供自动备份，拒绝注册: ${descriptor.name}`);
    }
    if (
      descriptor.mutationKind === "delete-protected-backup" &&
      descriptor.backupPolicy !== "protected-vault-deletion"
    ) {
      throw new Error(`删除备份工具未使用特权删除策略，拒绝注册: ${descriptor.name}`);
    }
    if (
      descriptor.mutationKind === "delete-protected-backup" &&
      descriptor.authorizationPolicy !== "backup-deletion"
    ) {
      throw new Error(`删除备份工具未使用专用授权策略，拒绝注册: ${descriptor.name}`);
    }
    this.descriptorsByName.set(descriptor.name, descriptor);
  }

  registerMany(descriptors: ToolDescriptor[]): void {
    for (const descriptor of descriptors) {
      this.register(descriptor);
    }
  }

  isRegistered(toolName: string): boolean {
    return this.descriptorsByName.has(toolName);
  }

  getDescriptor(toolName: string): ToolDescriptor | undefined {
    return this.descriptorsByName.get(toolName);
  }

  getPreviewDescriptors(): ToolDescriptorPreview[] {
    return [...this.descriptorsByName.values()].map((descriptor) => ({
      name: descriptor.name,
      summary: descriptor.summary,
    }));
  }

  getFullDescriptors(): ToolDescriptor[] {
    return [...this.descriptorsByName.values()];
  }

  /** 三级 Agent 最小工具集：仅支持该任务类型的工具。 */
  getSubsetForTask(taskType: string): ToolDescriptor[] {
    return [...this.descriptorsByName.values()].filter((descriptor) =>
      descriptor.supportedTaskTypes.includes(taskType),
    );
  }

  /** 估算工具描述注入的 token 数（按 4 字符/token 近似）。 */
  static estimateDescriptorTokenCount(
    descriptors: Array<Pick<ToolDescriptor, "name" | "summary" | "inputSchema">>,
  ): number {
    const serializedLength = descriptors.reduce(
      (totalLength, descriptor) =>
        totalLength +
        descriptor.name.length +
        descriptor.summary.length +
        JSON.stringify(descriptor.inputSchema).length,
      0,
    );
    return Math.ceil(serializedLength / 4);
  }
}
