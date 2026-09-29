/**
 * GUI/MCP 入口运行时选择反例（BRIDGE-01 / GUI-01-R）：
 * 缺参数必须 fail-closed（稳定错误码 → 退出码 2），绝不静默回退 mock。
 */
import { describe, expect, it } from "vitest";

import {
  RuntimeSelectionError,
  buildRuntimeSelection,
} from "../../../packages/tui/src/cli/runtime-selection.js";

describe("CLI 共用运行时选择", () => {
  it("缺省与 mock 都返回离线运行时", () => {
    expect(buildRuntimeSelection({ runtime: undefined }).runtime).toBe("mock");
    expect(buildRuntimeSelection({ runtime: "mock" }).runtime).toBe("mock");
  });

  it("openai-compatible 完整参数 → provider 选择（注册表 + 受保护引用）", () => {
    const selection = buildRuntimeSelection({
      runtime: "openai-compatible",
      providerEndpoint: "http://127.0.0.1:9/v1/chat/completions",
      providerModelIdentifier: "test-model",
    });
    expect(selection.runtime).toBe("provider");
    expect(selection.providerRuntimeRegistry).toBeDefined();
    expect(selection.provider?.providerId).toBe("openai-compatible");
    expect(selection.provider?.modelIdentifier).toBe("test-model");
    expect(selection.provider?.allowedModelIdentifiers).toEqual(["test-model"]);
  });

  it("缺端点 → RuntimeSelectionError(provider-endpoint-missing)", () => {
    try {
      buildRuntimeSelection({ runtime: "openai-compatible", providerModelIdentifier: "m" });
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeSelectionError);
      expect((error as RuntimeSelectionError).errorCode).toBe("provider-endpoint-missing");
    }
  });

  it("缺模型 → RuntimeSelectionError(provider-model-missing)", () => {
    try {
      buildRuntimeSelection({
        runtime: "openai-compatible",
        providerEndpoint: "http://127.0.0.1:9/v1/chat/completions",
      });
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeSelectionError);
      expect((error as RuntimeSelectionError).errorCode).toBe("provider-model-missing");
    }
  });

  it("不支持的运行时 → RuntimeSelectionError(runtime-unsupported)", () => {
    try {
      buildRuntimeSelection({ runtime: "bogus" });
      throw new Error("应当抛错");
    } catch (error) {
      expect((error as RuntimeSelectionError).errorCode).toBe("runtime-unsupported");
    }
  });
});
