/**
 * 权限能力目录（T06F / ADR-0020）。
 * 本地版本化 PermissionCapabilityCatalog：每个可配置权限包含稳定 ID、
 * 显示名称、说明、Devolve/Assist 默认值、适用资源、风险摘要和工具映射。
 * 未映射工具拒绝注册和执行；工具需要多项权限时取最严格结果：
 * 任一 deny → deny；否则任一 ask → ask；全部 allow → allow。
 *
 * 内部强制执行层（敏感内容禁读、自动备份、身份认证、工具注册与参数
 * schema、真实路径/工作区/OS 边界、审计完整性、不可代理的用户确认）
 * 不属于可配置权限，不进入目录、设置、帮助、导出、普通审计或模型描述。
 */
import type { PermissionResult, ToolDescriptor } from "../core/types.js";

export const PERMISSION_CATALOG_VERSION = 1;

export type PermissionDecision = PermissionResult;

export interface PermissionCapability {
  capabilityId: string;
  displayName: string;
  description: string;
  devolveDefault: PermissionDecision;
  assistDefault: PermissionDecision;
  applicableResources: string[];
  riskSummary: string;
  /** 使用该权限的工具名列表。 */
  toolMappings: string[];
}

/** 目录条目定义（不直接暴露 displayName 之外的产品面）。 */
interface CapabilityDefinition {
  capabilityId: string;
  displayName: string;
  description: string;
  devolveDefault: PermissionDecision;
  assistDefault: PermissionDecision;
  applicableResources: string[];
  riskSummary: string;
}

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  { capabilityId: "project.read", displayName: "项目读取", description: "普通项目文件、目录和文本检索", devolveDefault: "allow", assistDefault: "allow", applicableResources: ["workspace"], riskSummary: "低" },
  { capabilityId: "project.create", displayName: "项目新建", description: "新建项目内容", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["workspace"], riskSummary: "中" },
  { capabilityId: "project.modify", displayName: "项目修改", description: "修改非破坏性项目内容", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["workspace"], riskSummary: "中" },
  { capabilityId: "project.destructive-mutate", displayName: "破坏性修改", description: "删除、覆盖、替换、截断和重命名覆盖", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["workspace"], riskSummary: "高" },
  { capabilityId: "process.execute-sandboxed", displayName: "沙箱进程执行", description: "在工作区沙箱执行进程", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["sandbox"], riskSummary: "中" },
  { capabilityId: "process.execute-host", displayName: "宿主进程执行", description: "在宿主环境执行进程", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["host"], riskSummary: "高" },
  { capabilityId: "network.read", displayName: "只读网络", description: "只读网络请求和资料取得", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["network"], riskSummary: "中" },
  { capabilityId: "network.write", displayName: "网络写入", description: "上传、提交或改变远端状态", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["network"], riskSummary: "高" },
  { capabilityId: "browser.read", displayName: "浏览器只读", description: "查看网页和浏览器只读状态", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["browser"], riskSummary: "中" },
  { capabilityId: "browser.interact", displayName: "浏览器交互", description: "点击、输入、提交表单和下载", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["browser"], riskSummary: "高" },
  { capabilityId: "connector.read", displayName: "连接器读取", description: "从外部连接器读取数据", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["connector"], riskSummary: "中" },
  { capabilityId: "connector.write", displayName: "连接器写入", description: "通过外部连接器创建或修改数据", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["connector"], riskSummary: "高" },
  { capabilityId: "database.read", displayName: "数据库读取", description: "查询数据库", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["database"], riskSummary: "中" },
  { capabilityId: "database.write", displayName: "数据库写入", description: "修改数据库及其结构", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["database"], riskSummary: "高" },
  { capabilityId: "cloud.read", displayName: "云资源读取", description: "查看云资源与部署状态", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["cloud"], riskSummary: "中" },
  { capabilityId: "cloud.write", displayName: "云资源写入", description: "创建、更新或删除云资源", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["cloud"], riskSummary: "高" },
  { capabilityId: "clipboard.read", displayName: "剪贴板读取", description: "读取系统剪贴板", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["clipboard"], riskSummary: "中" },
  { capabilityId: "clipboard.write", displayName: "剪贴板写入", description: "写入系统剪贴板", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["clipboard"], riskSummary: "中" },
  { capabilityId: "environment.read", displayName: "环境读取", description: "读取普通运行环境信息", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["environment"], riskSummary: "中" },
  { capabilityId: "environment.modify", displayName: "环境修改", description: "修改运行环境和持久环境配置", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["environment"], riskSummary: "高" },
  { capabilityId: "code-repository.acquire", displayName: "代码库获取", description: "clone/download/vendor 代码库", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["repository"], riskSummary: "中" },
  { capabilityId: "dependency.install-project", displayName: "项目依赖安装", description: "安装或更新项目级依赖", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["project-dependencies"], riskSummary: "中" },
  { capabilityId: "dependency.install-global", displayName: "全局依赖安装", description: "安装全局依赖、运行时和工具链", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["global-dependencies"], riskSummary: "高" },
  { capabilityId: "extension.install", displayName: "扩展安装", description: "安装插件、技能、模型或扩展", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["extension"], riskSummary: "高" },
  { capabilityId: "git.read", displayName: "Git 只读", description: "Git 只读查询", devolveDefault: "allow", assistDefault: "allow", applicableResources: ["repository"], riskSummary: "低" },
  { capabilityId: "git.write-local", displayName: "Git 本地写入", description: "commit、普通分支和本地合并", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["repository"], riskSummary: "中" },
  { capabilityId: "git.rewrite-history", displayName: "Git 历史改写", description: "rebase、reset、clean、强制移动引用", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["repository"], riskSummary: "高" },
  { capabilityId: "git.remote-write", displayName: "Git 远端写入", description: "push、PR 和远端引用修改", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["repository"], riskSummary: "高" },
  { capabilityId: "external.publish", displayName: "外部发布", description: "发布包、部署或公开内容", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["external"], riskSummary: "高" },
  { capabilityId: "external.communicate", displayName: "外部通信", description: "代表用户发送消息、邮件或通知", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["external"], riskSummary: "高" },
  { capabilityId: "financial.transact", displayName: "资金交易", description: "付款、购买、交易和资金操作", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["financial"], riskSummary: "极高" },
  { capabilityId: "system.modify", displayName: "系统修改", description: "修改系统设置、服务、权限或注册表", devolveDefault: "allow", assistDefault: "deny", applicableResources: ["system"], riskSummary: "极高" },
  { capabilityId: "backup.list", displayName: "备份列表", description: "查看受控备份元数据", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["backup"], riskSummary: "中" },
  { capabilityId: "backup.read", displayName: "备份读取", description: "读取受控备份业务内容", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["backup"], riskSummary: "中" },
  { capabilityId: "backup.restore", displayName: "备份恢复", description: "恢复备份", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["backup"], riskSummary: "高" },
  { capabilityId: "backup.delete", displayName: "备份删除", description: "删除备份", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["backup"], riskSummary: "高" },
  { capabilityId: "agent.spawn", displayName: "三级 Agent 创建", description: "次级 Agent 创建所属三级 Agent", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["agent"], riskSummary: "高" },
  { capabilityId: "agent.delegate", displayName: "三级 Agent 派发", description: "次级 Agent 向所属三级 Agent 发布或重派任务", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["agent"], riskSummary: "中" },
  { capabilityId: "agent.manage", displayName: "三级 Agent 管理", description: "次级 Agent 暂停、取消和回收所属三级 Agent", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["agent"], riskSummary: "高" },
  { capabilityId: "agent.communication-delegate", displayName: "沟通句柄转交", description: "直属上级把直属低一级 Agent 的限定沟通句柄授权给具体同级 Agent", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["agent"], riskSummary: "高" },
  { capabilityId: "task.read", displayName: "任务读取", description: "查询任务和偏序集状态", devolveDefault: "allow", assistDefault: "allow", applicableResources: ["task"], riskSummary: "低" },
  { capabilityId: "task.manage", displayName: "任务管理", description: "创建、插入、改序、取消任务", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["task"], riskSummary: "中" },
  { capabilityId: "memory.read-selected", displayName: "记忆选择性读取", description: "读取明确选择的 Agent 存档条目", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["memory"], riskSummary: "中" },
  { capabilityId: "memory.write", displayName: "记忆写入", description: "写入任务记忆与工作存档", devolveDefault: "allow", assistDefault: "ask", applicableResources: ["memory"], riskSummary: "中" },
];

/** 内置工具 → 权限映射（注册校验与执行裁决用）。 */
const DEFAULT_TOOL_CAPABILITY_MAPPINGS: Record<string, string[]> = {
  readFile: ["project.read"],
  listDirectory: ["project.read"],
  writeFileTemporary: ["project.create"],
  // 覆盖写是破坏性变更：Assist 下 destructive-mutate 默认 deny → 整体 deny
  replaceFileContent: ["project.modify", "project.destructive-mutate"],
  backupVault: ["backup.read"],
  deleteBackup: ["backup.delete"],
  taskSequenceStatus: ["task.read"],
  searchProjectText: ["project.read"],
  gitReadonlyView: ["git.read"],
  factVerification: ["network.read"],
};

export class PermissionCapabilityCatalog {
  private readonly capabilitiesById = new Map<string, PermissionCapability>();
  private readonly toolMappings = new Map<string, string[]>();

  constructor() {
    for (const definition of CAPABILITY_DEFINITIONS) {
      const mappings = DEFAULT_TOOL_CAPABILITY_MAPPINGS
        ? Object.entries(DEFAULT_TOOL_CAPABILITY_MAPPINGS)
            .filter(([, capabilityIds]) => capabilityIds.includes(definition.capabilityId))
            .map(([toolName]) => toolName)
        : [];
      this.capabilitiesById.set(definition.capabilityId, {
        ...definition,
        toolMappings: mappings,
      });
    }
    for (const [toolName, capabilityIds] of Object.entries(DEFAULT_TOOL_CAPABILITY_MAPPINGS)) {
      this.toolMappings.set(toolName, capabilityIds);
    }
  }

  getCatalogVersion(): number {
    return PERMISSION_CATALOG_VERSION;
  }

  getCapability(capabilityId: string): PermissionCapability | undefined {
    return this.capabilitiesById.get(capabilityId);
  }

  listCapabilities(): PermissionCapability[] {
    return [...this.capabilitiesById.values()];
  }

  getCapabilityIds(): string[] {
    return [...this.capabilitiesById.keys()];
  }

  /** 工具已映射到至少一项权限（未映射拒绝注册/执行）。 */
  getToolCapabilityIds(toolName: string): string[] {
    return this.toolMappings.get(toolName) ?? [];
  }

  isToolMapped(toolName: string): boolean {
    return this.toolMappings.has(toolName);
  }

  /**
   * 按 profile 决定裁决工具（最严格结果）：
   * 任一 deny → deny；否则任一 ask → ask；全部 allow → allow。
   */
  evaluateToolPermission(input: {
    toolName: string;
    capabilityDecisions: Record<string, PermissionDecision>;
  }): PermissionDecision {
    const capabilityIds = this.getToolCapabilityIds(input.toolName);
    if (capabilityIds.length === 0) {
      return "deny"; // 未映射工具拒绝执行
    }
    let hasAsk = false;
    for (const capabilityId of capabilityIds) {
      const decision = input.capabilityDecisions[capabilityId] ?? "deny";
      if (decision === "deny") {
        return "deny";
      }
      if (decision === "ask") {
        hasAsk = true;
      }
    }
    return hasAsk ? "ask" : "allow";
  }

  /** 工具注册校验：未映射拒绝（由 ToolRegistry 调用）。 */
  assertToolMapped(descriptor: ToolDescriptor): void {
    if (!this.isToolMapped(descriptor.name)) {
      throw new Error(
        `工具 ${descriptor.name} 未映射任何可配置权限，拒绝注册`,
      );
    }
  }
}
