import { describe, expect, it } from "vitest";

import {
  ASSIST_SESSION_AUTHORIZATION_TTL_MINUTES,
  AGENT_MODE_DISPLAY_NAMES,
  BACKUP_DELETION_AUDIT_PRIORITY,
  DEFAULT_BACKOFF_RESET_SECONDS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
  DEFAULT_TOOL_FAILURE_THRESHOLD,
  DESTRUCTIVE_BACKUP_MANIFEST_SCHEMA_VERSION,
  DESTRUCTIVE_TOOL_MUTATION_KINDS,
  MAX_CONCURRENCY,
  MESSAGE_PRIORITY_ORDER,
  MIN_CONCURRENCY,
} from "../../../packages/core/src/core/types.js";

/**
 * 冻结决策守卫测试：保证 IMPLEMENTATION_PLAN.md §2 的冻结决策
 * 在实现中仍以常量和顺序形式保留，防止静默修改。
 */
describe("冻结决策常数与实现一致", () => {
  it("三级 Agent 连续失败阈值默认 3 次", () => {
    expect(DEFAULT_TOOL_FAILURE_THRESHOLD).toBe(3);
  });

  it("反馈退避单次等待上限为 3 小时（10,800 秒）", () => {
    expect(DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS).toBe(10_800);
  });

  it("新消息重置后回到 2 秒基础间隔", () => {
    expect(DEFAULT_BACKOFF_RESET_SECONDS).toBe(2);
  });

  it("默认并发量为 4，可配置范围 1–32", () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBe(4);
    expect(MIN_CONCURRENCY).toBe(1);
    expect(MAX_CONCURRENCY).toBe(32);
  });

  it("Assist 会话授权默认 10 分钟", () => {
    expect(ASSIST_SESSION_AUTHORIZATION_TTL_MINUTES).toBe(10);
  });

  it("备份删除警告紧随 instruction，优先于普通失败和权限请求", () => {
    expect(MESSAGE_PRIORITY_ORDER).toEqual([
      "instruction",
      "backup-deletion-warning",
      "failure",
      "permission-ask",
      "ambiguous",
      "success",
    ]);
  });

  it("删除、文本删除、覆盖、替换和截断均属于必须备份的破坏性变更", () => {
    expect(DESTRUCTIVE_TOOL_MUTATION_KINDS).toEqual([
      "delete-resource",
      "delete-content",
      "overwrite",
      "replace",
      "truncate",
      "delete-protected-backup",
    ]);
    expect(DESTRUCTIVE_BACKUP_MANIFEST_SCHEMA_VERSION).toBe(1);
  });

  it("三种模式中文名称固定为思索、协同、放权", () => {
    expect(AGENT_MODE_DISPLAY_NAMES).toEqual({
      ponder: "思索模式",
      assist: "协同模式",
      devolve: "放权模式",
    });
  });

  it("删除备份审计记录使用高查阅优先级", () => {
    expect(BACKUP_DELETION_AUDIT_PRIORITY).toBe("high");
  });
});
