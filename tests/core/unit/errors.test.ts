import { describe, expect, it } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";

describe("DomainError", () => {
  it("构造后可读取稳定 errorCode", () => {
    const error = new DomainError("tool-not-found", "工具 read 不存在");
    expect(error.errorCode).toBe("tool-not-found");
  });

  it("默认不可恢复", () => {
    const error = new DomainError("tool-not-found", "工具 read 不存在");
    expect(error.isRecoverable).toBe(false);
  });

  it("可显式标记可恢复", () => {
    const error = new DomainError(
      "provider-timeout",
      "Provider 超时",
      true,
    );
    expect(error.isRecoverable).toBe(true);
  });

  it("保持标准 Error 行为", () => {
    const error = new DomainError("mission-not-found", "任务不存在");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DomainError");
    expect(error.message).toBe("任务不存在");
  });
});
