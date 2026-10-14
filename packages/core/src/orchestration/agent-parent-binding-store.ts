/**
 * COMM-01-02（2026-10-18 首版；**2026-10-22 依设计清单与用户澄清订正**）：
 * **Agent 创建来源登记**与**按地址投递的地址完整性**。
 *
 * ## 订正说明（重要，避免后来者沿用错误模型）
 *
 * 首版把本模块写成"**唯一上级 = 通信授权**"（一个子只能有一个上级，
 * 且只允许直属上级投递）。**那是错的**：
 *
 * - `docs/AGENT_COMMUNICATION_OVERVIEW.md` §35–54（"上层受控全连接，下层唯一上级"）：
 *   **同项目的主层与次级层默认全连接**，不逐边申请通信授权；
 *   **跨项目**按需连接，且只有主—主（另有次级—次级建议通道）须授权；
 *   三级/四级"只向**唯一直属上级**请示和报告"，其他协作请求由直属上级**代理转达**。
 * - **反馈不按上下级关系走**：每条任务的消息默认走**任务发布者的反向通道**。
 * - **绑定记录**是**创建时自动登记**的来源事实（上级 Agent 需要下级时，
 *   由**创建工具自动产生新记录并由该工具一致管理**），**不是通信授权**。
 * - 向**没有绑定记录**的对象投递 ⇒ **直接拒绝**（地址完整性：那不是已知主体）。
 *
 * ⇒ 本模块的正确职责是两件事，**都不是**"通信授权"：
 *   1. **创建来源登记**（谁创建了谁；作为地址主体存在性的依据）；
 *   2. **按地址投递的地址完整性**（收件人必须是已登记主体，否则拒收）。
 *
 * **本模块刻意不实现**"只有直属上级能给子发消息"这类规则 —— 那会**阻断**
 * 同项目主↔次级的默认可达，属功能性破坏。
 *
 * ## 与既有模块的分工
 * `UnboundedAgentInstanceRegistry` 管个体生命周期与资源准入；本模块只管
 * "这个主体是谁创建的、以及它是否是一个已登记的可投递地址"。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE_NAME = "agent-creation-registry.json";

export interface AgentCreationRecord {
  /** 被创建的具体个体（不可复用）。 */
  agentInstanceId: string;
  /** 创建者（由创建工具自动登记，**不是**模型声明）。 */
  createdByAgentInstanceId: string | null;
  /** `createdByAgentInstanceId === null` 表示由用户/控制面直接创建。 */
  createdAtIso: string;
  /** 回收时间；非 null 表示该主体已不再活跃（历史仍保留）。 */
  recycledAtIso: string | null;
}

export interface AgentCreationRegistryOptions {
  stateDirectory: string;
  /** 可注入时钟（测试用）；默认真实时间。 */
  nowIso?: () => string;
}

/** 创建来源的**持久化**登记（只读写，不含判定规则）。 */
export class AgentCreationRegistry {
  private readonly stateDirectory: string;
  private readonly nowIso: () => string;
  private readonly recordsByAgentInstanceId = new Map<string, AgentCreationRecord>();
  private isLoaded = false;

  constructor(options: AgentCreationRegistryOptions) {
    this.stateDirectory = options.stateDirectory;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  private get stateFilePath(): string {
    return path.join(this.stateDirectory, STATE_FILE_NAME);
  }

  async ensureLoaded(): Promise<void> {
    if (this.isLoaded) {
      return;
    }
    this.isLoaded = true;
    let rawText: string;
    try {
      rawText = await fs.readFile(this.stateFilePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(rawText) as {
        schemaVersion?: unknown;
        records?: unknown;
      };
      // 版本不符 ⇒ 按空继续（不伪造主体存在性）。
      if (parsed.schemaVersion !== 1) {
        return;
      }
      for (const raw of Array.isArray(parsed.records) ? parsed.records : []) {
        const record = raw as AgentCreationRecord;
        this.recordsByAgentInstanceId.set(record.agentInstanceId, record);
      }
    } catch {
      // 损坏状态：按空继续（**不伪造存在性** —— 伪造会让未知主体变成可投递地址）。
    }
  }

  /** 登记新建主体（由**创建工具**调用）。同一主体重复登记 ⇒ 幂等（保留首次来源）。 */
  async registerCreatedAgent(input: {
    agentInstanceId: string;
    createdByAgentInstanceId: string | null;
  }): Promise<AgentCreationRecord> {
    await this.ensureLoaded();
    const existing = this.recordsByAgentInstanceId.get(input.agentInstanceId);
    if (existing !== undefined) {
      return existing;
    }
    const record: AgentCreationRecord = {
      agentInstanceId: input.agentInstanceId,
      createdByAgentInstanceId: input.createdByAgentInstanceId,
      createdAtIso: this.nowIso(),
      recycledAtIso: null,
    };
    this.recordsByAgentInstanceId.set(input.agentInstanceId, record);
    await this.persist();
    return record;
  }

  async getRecord(agentInstanceId: string): Promise<AgentCreationRecord | null> {
    await this.ensureLoaded();
    return this.recordsByAgentInstanceId.get(agentInstanceId) ?? null;
  }

  /** 是否为一个**已登记**的地址主体（地址完整性的唯一依据）。 */
  async isRegisteredAgent(agentInstanceId: string): Promise<boolean> {
    return (await this.getRecord(agentInstanceId)) !== null;
  }

  /** 标记回收：历史记录保留（可追溯"谁建的"），但不再是活跃地址。 */
  async markRecycled(agentInstanceId: string): Promise<void> {
    await this.ensureLoaded();
    const record = this.recordsByAgentInstanceId.get(agentInstanceId);
    if (record === undefined || record.recycledAtIso !== null) {
      return;
    }
    record.recycledAtIso = this.nowIso();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    const records = [...this.recordsByAgentInstanceId.values()];
    await fs.writeFile(
      this.stateFilePath,
      JSON.stringify({ schemaVersion: 1, records }, null, 2) + "\n",
      "utf8",
    );
  }
}

export interface AgentAddressGuardOptions {
  registry: AgentCreationRegistry;
}

/**
 * 按地址投递的**地址完整性**判定器。
 *
 * 只回答一个问题：**收件人是不是一个已登记的主体？**
 * 刻意**不**回答"发送者是否有权给该收件人发消息" —— 按设计清单，
 * 同项目主层与次级层默认可达、反馈走任务发布者反向通道，
 * 都不由创建来源决定。
 */
export class AgentAddressGuard {
  private readonly registry: AgentCreationRegistry;

  constructor(options: AgentAddressGuardOptions) {
    this.registry = options.registry;
  }

  /**
   * 收件人是否为可投递地址。
   * - 已登记且未回收 ⇒ `true`；
   * - **无绑定记录**（未登记）⇒ `false`（直接拒绝）；
   * - 已回收 ⇒ `false`（不再活跃；历史仍可查）。
   */
  async isDeliverableRecipient(recipientAgentInstanceId: string): Promise<boolean> {
    const record = await this.registry.getRecord(recipientAgentInstanceId);
    if (record === null) {
      return false;
    }
    return record.recycledAtIso === null;
  }

  /** 历史创建来源（含已回收）—— 供追溯"这个主体是谁建的"。 */
  async resolveCreatorOf(agentInstanceId: string): Promise<string | null> {
    const record = await this.registry.getRecord(agentInstanceId);
    return record === null ? null : record.createdByAgentInstanceId;
  }
}
