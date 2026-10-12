/**
 * GUI-02-02 专用流程（2026-10-12）：**待决安装询问的注册表**。
 *
 * 为什么需要它：安装门禁（`InstallationGateGuard`）在工具执行前**自己**完成了
 * 完整判定 —— 询问是否已有资源 → 独立安装开关 → `askAllowOnce` → 授权
 * → **执行前复检**；普通权限询问的批准**不参与**这套判定（故安装**不能被普通授权卡绕过**）。
 *
 * 但 `InstallationGateUserPort` 需要一个**可信交互通道**；GUI 此前未提供
 * （`installationUserPort: null`）⇒ GUI 里的安装尝试一律被判
 * 「无可信交互通道，安装被拒绝（fail-closed）」⇒ **安装根本走不通**。
 *
 * 本模块把"等待中的询问"落成**本地权威记录**，使 GUI/CLI 能：
 * 1. **展示**待决询问（GET 只读）；
 * 2. 经**专用裁决入口**回答（`answerInquiry` / `decideAllowOnce`）；
 * 3. 让等待方的 promise 以该回答结束（会话内）。
 *
 * 安全性质：
 * - 记录**只存阶段所需字段**，不存任何凭据；
 * - 回答**必须匹配询问自身 revision**（过期/重复回答被拒）；
 * - **未回答 / 超时** ⇒ 返回 `null` ⇒ 门禁 fail-closed（不放行、不静默降级）；
 * - 本注册表**不做出授权决定**：只传递用户回答，判定仍由门禁与授权控制器完成。
 */
import { DomainError } from "../core/errors.js";

/** 待决询问的两个阶段。 */
export type InstallationInquiryStage = "existing-resource" | "allow-once";

/** 待决安装询问记录（界面所需字段 + 裁决所需锚点）。 */
export interface InstallationInquiryRecord {
  /** 锚点（不可猜测地用 UUID；调用方据此回答）。 */
  inquiryIdentifier: string;
  stage: InstallationInquiryStage;
  /** 询问所属的发起个体（不可复用身份）。 */
  requestingAgentInstanceId: string;
  taskExecutionId: string;
  /** 需要的能力摘要（阶段 1）或安装计划摘要（阶段 2）。 */
  summary: string;
  /** 阶段 2 的精确计划字段（供用户判断；阶段 1 为 null）。 */
  installationPlan: {
    packageOrRepositoryIdentifier: string;
    pinnedVersionOrCommit: string | null;
    targetPathOrScope: string;
    packageManager: string;
    expectedChangesSummary: string;
    requiresNetwork: boolean;
    hasInstallScripts: boolean;
    parametersJson: string;
  } | null;
  status: "pending" | "answered" | "expired" | "cancelled";
  /** 自身 revision：回答必须带上，过期回答被拒（不复用旧回答）。 */
  revision: number;
  createdAtIso: string;
  answeredAtIso: string | null;
}

/** 阶段 1 的用户回答（与既有 `ExistingResourceAnswer` 结构兼容）。 */
export type InstallationInquiryAnswer =
  | { answer: "no-resource" }
  | {
      answer: "has-resource";
      resourceReference: string;
      providedResourceType: string;
    };

/** 阶段 2 的用户决定。 */
export type InstallationAllowOnceDecision = "allow-once" | "deny";

/**
 * 内存中的待决询问注册表（**会话内**）。
 *
 * 说明：安装询问是**会话内即时交互**（门禁在工具执行前同步等待），
 * 故以进程内注册表承载即可，**不落盘**（不引入跨进程陈旧回答风险）。
 * 若宿主重启，等待中的询问自然消失 ⇒ 门禁 fail-closed，符合既定语义。
 */
export class InstallationInquiryRegistry {
  private readonly records = new Map<string, InstallationInquiryRecord>();
  private readonly waiters = new Map<
    string,
    (value: InstallationInquiryAnswer | InstallationAllowOnceDecision | null) => void
  >();
  private counter = 0;

  constructor(private readonly nowMilliseconds: () => number = () => Date.now()) {}

  /** 登记一条待决询问并返回记录（调用方随后 `waitForAnswer`）。 */
  register(input: {
    stage: InstallationInquiryStage;
    requestingAgentInstanceId: string;
    taskExecutionId: string;
    summary: string;
    installationPlan?: InstallationInquiryRecord["installationPlan"];
  }): InstallationInquiryRecord {
    if (input.requestingAgentInstanceId === "") {
      throw new DomainError(
        "installation-inquiry-invalid",
        "安装询问必须携带具体的发起个体身份",
      );
    }
    this.counter += 1;
    const record: InstallationInquiryRecord = {
      inquiryIdentifier: `install-inquiry-${this.counter}-${this.nowMilliseconds().toString(36)}`,
      stage: input.stage,
      requestingAgentInstanceId: input.requestingAgentInstanceId,
      taskExecutionId: input.taskExecutionId,
      summary: input.summary,
      installationPlan: input.installationPlan ?? null,
      status: "pending",
      revision: 1,
      createdAtIso: new Date(this.nowMilliseconds()).toISOString(),
      answeredAtIso: null,
    };
    this.records.set(record.inquiryIdentifier, record);
    return record;
  }

  /** 只读：列出仍待决的询问（**新到旧**，供界面按需展示）。 */
  listPending(): InstallationInquiryRecord[] {
    return [...this.records.values()]
      .filter((record) => record.status === "pending")
      .sort((left, right) => right.createdAtIso.localeCompare(left.createdAtIso));
  }

  /** 只读：按锚点读取（不存在即 null）。 */
  read(inquiryIdentifier: string): InstallationInquiryRecord | null {
    return this.records.get(inquiryIdentifier) ?? null;
  }

  /**
   * 等待某询问的回答；超时或被取消 ⇒ 返回 `null`（**fail-closed**，绝不默认放行）。
   */
  waitForAnswer(
    inquiryIdentifier: string,
    timeoutMilliseconds: number,
  ): Promise<InstallationInquiryAnswer | InstallationAllowOnceDecision | null> {
    const record = this.records.get(inquiryIdentifier);
    if (record === undefined || record.status !== "pending") {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(inquiryIdentifier);
        const current = this.records.get(inquiryIdentifier);
        if (current !== undefined && current.status === "pending") {
          current.status = "expired";
          current.revision += 1;
        }
        resolve(null);
      }, timeoutMilliseconds);
      this.waiters.set(inquiryIdentifier, (value) => {
        clearTimeout(timer);
        this.waiters.delete(inquiryIdentifier);
        resolve(value);
      });
    });
  }

  /**
   * 回答**阶段 1**（是否已有资源）。
   *
   * 必须匹配 `expectedRevision`：过期/重复回答被拒（**不复用旧回答**）。
   */
  answerInquiry(input: {
    inquiryIdentifier: string;
    expectedRevision: number;
    answer: InstallationInquiryAnswer;
  }): InstallationInquiryRecord {
    const record = this.requirePending(input.inquiryIdentifier, input.expectedRevision, "existing-resource");
    record.status = "answered";
    record.answeredAtIso = new Date(this.nowMilliseconds()).toISOString();
    record.revision += 1;
    this.waiters.get(input.inquiryIdentifier)?.(input.answer);
    return record;
  }

  /** 回答**阶段 2**（是否允许本次安装）。 */
  decideAllowOnce(input: {
    inquiryIdentifier: string;
    expectedRevision: number;
    decision: InstallationAllowOnceDecision;
  }): InstallationInquiryRecord {
    const record = this.requirePending(input.inquiryIdentifier, input.expectedRevision, "allow-once");
    record.status = "answered";
    record.answeredAtIso = new Date(this.nowMilliseconds()).toISOString();
    record.revision += 1;
    this.waiters.get(input.inquiryIdentifier)?.(input.decision);
    return record;
  }

  /** 取消（例如会话关闭）：等待方立即得到 `null` ⇒ fail-closed。 */
  cancel(inquiryIdentifier: string): void {
    const record = this.records.get(inquiryIdentifier);
    if (record === undefined) {
      return;
    }
    if (record.status === "pending") {
      record.status = "cancelled";
      record.revision += 1;
    }
    this.waiters.get(inquiryIdentifier)?.(null);
  }

  private requirePending(
    inquiryIdentifier: string,
    expectedRevision: number,
    expectedStage: InstallationInquiryStage,
  ): InstallationInquiryRecord {
    const record = this.records.get(inquiryIdentifier);
    if (record === undefined) {
      throw new DomainError(
        "installation-inquiry-not-found",
        "未找到该安装询问，可能已失效",
      );
    }
    if (record.stage !== expectedStage) {
      throw new DomainError(
        "installation-inquiry-stage-mismatch",
        `该询问处于「${record.stage}」阶段，不能用「${expectedStage}」的回答`,
      );
    }
    if (record.status !== "pending") {
      throw new DomainError(
        "installation-inquiry-already-answered",
        "该安装询问已被回答或已失效",
      );
    }
    if (record.revision !== expectedRevision) {
      throw new DomainError(
        "installation-inquiry-stale-revision",
        "安装询问已变化，请刷新后重新裁决",
      );
    }
    return record;
  }
}
