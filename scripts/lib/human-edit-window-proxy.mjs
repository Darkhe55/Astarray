/**
 * E2E-01-03 真实 Provider 下的**人工编辑窗口代理**（原生 ESM，供脚本直接 node 执行）。
 *
 * 问题：离线 harness 的同步点靠"假 Provider 拦下第二次响应"实现；真实 Provider 下无法拦截，
 * 而模型"读完立刻写"的窗口只有 1 秒级，人来不及编辑。
 *
 * 解法：把本代理放在 CLI 与真实端点之间——
 *  - 纯**透传**（不改请求/响应内容；**不接触凭据**：密钥仍由 harness 注入 CLI 环境变量）；
 *  - 当某次上游响应里出现**目标工具调用**（默认 `replaceFileContent`）时，
 *    先**扣住该响应**，提示人工编辑目标文件，**直到检测到目标文件内容变化**才放行；
 *  - 其余响应立即放行；超时则放行并如实标记"未检测到人工编辑"（**不伪造成功**）。
 *
 * 于是窗口由本地控制、与模型手速无关，同时仍是真实 Provider + 真实模型 + 用户亲手编辑。
 */
import http from "node:http";
import { readFileSync } from "node:fs";

/**
 * 从 SSE 响应体里解析出**真实发起**的工具名（不是文字里提到的）。
 * 兼容 openai-compatible（`choices[].delta|message.tool_calls[].function.name`）
 * 与 anthropic-messages（`content_block_start.content_block.name`）。
 * @param {string} responseBody
 * @returns {string[]}
 */
export function extractRequestedToolNames(responseBody) {
  const toolNames = [];
  for (const rawLine of responseBody.split(/\r?\n/)) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine.startsWith("data:")) continue;
    const payloadText = trimmedLine.slice("data:".length).trim();
    if (payloadText === "" || payloadText === "[DONE]") continue;
    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payloadText);
    } catch {
      continue;
    }
    const choices = Array.isArray(parsedPayload?.choices) ? parsedPayload.choices : [];
    for (const choice of choices) {
      for (const container of [choice?.delta, choice?.message]) {
        const toolCalls = Array.isArray(container?.tool_calls) ? container.tool_calls : [];
        for (const toolCall of toolCalls) {
          const toolName = toolCall?.function?.name;
          if (typeof toolName === "string" && toolName !== "") toolNames.push(toolName);
        }
      }
    }
    if (
      parsedPayload?.type === "content_block_start" &&
      parsedPayload?.content_block?.type === "tool_use" &&
      typeof parsedPayload.content_block.name === "string"
    ) {
      toolNames.push(parsedPayload.content_block.name);
    }
  }
  return toolNames;
}

/**
 * @param {{
 *   upstreamEndpoint: string,
 *   targetFilePath: string,
 *   initialTargetContent: string,
 *   holdMarker?: string,
 *   humanEditDeadlineMilliseconds?: number,
 *   onHumanEditInstruction?: (detail: { targetFilePath: string, deadlineMilliseconds: number }) => void,
 *   onHumanEditDetected?: (detail: { targetFilePath: string, detectedContent: string }) => void,
 * }} options
 */
export async function startHumanEditWindowProxy(options) {
  const holdMarker = options.holdMarker ?? "replaceFileContent";
  const deadlineMilliseconds = options.humanEditDeadlineMilliseconds ?? 300_000;
  let requestCount = 0;
  let heldResponseCount = 0;
  let isHumanEditDetected = false;
  let detectedHumanContent = null;
  const requestBodyTexts = [];
  const upstreamResponseTexts = [];
  const requestedToolNamesByRequest = [];

  const readTargetContent = () => {
    try {
      return readFileSync(options.targetFilePath, "utf8");
    } catch {
      return null;
    }
  };

  const waitForHumanEdit = async () => {
    options.onHumanEditInstruction?.({
      targetFilePath: options.targetFilePath,
      deadlineMilliseconds,
    });
    const startedAtMilliseconds = Date.now();
    while (Date.now() - startedAtMilliseconds < deadlineMilliseconds) {
      const currentContent = readTargetContent();
      if (currentContent !== null && currentContent !== options.initialTargetContent) {
        isHumanEditDetected = true;
        detectedHumanContent = currentContent;
        options.onHumanEditDetected?.({
          targetFilePath: options.targetFilePath,
          detectedContent: currentContent,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // 超时：放行但**不**声称检测到人工编辑（不得伪造成功）。
    isHumanEditDetected = false;
  };

  const server = http.createServer((incomingRequest, outgoingResponse) => {
    let requestBody = "";
    incomingRequest.on("data", (chunk) => {
      requestBody += String(chunk);
    });
    incomingRequest.on("end", () => {
      void (async () => {
        requestCount += 1;
        const currentRequestIndex = requestCount;
        requestBodyTexts.push(requestBody);
        // 透传请求头（去掉 host/content-length；其余原样，含 CLI 自己带的鉴权头）。
        const forwardedHeaders = {};
        for (const [headerName, headerValue] of Object.entries(incomingRequest.headers)) {
          if (headerName === "host" || headerName === "content-length") continue;
          forwardedHeaders[headerName] = Array.isArray(headerValue)
            ? headerValue.join(", ")
            : String(headerValue ?? "");
        }
        let upstreamStatus = 502;
        let upstreamBody = "";
        try {
          const upstreamResponse = await fetch(options.upstreamEndpoint, {
            method: "POST",
            headers: forwardedHeaders,
            body: requestBody,
          });
          upstreamStatus = upstreamResponse.status;
          upstreamBody = await upstreamResponse.text();
        } catch (error) {
          upstreamBody = JSON.stringify({ error: "proxy-upstream-failure: " + String(error) });
        }
        // 只在"含目标工具调用"且"尚未检测到人工编辑"时扣留响应。
        /**
         * 只在"**真实发起**了目标工具调用"且"尚未检测到人工编辑"时扣留响应。
         *
         * 2026-10-09 实测教训：此前用 `upstreamBody.includes(holdMarker)` 子串匹配，
         * 会把"模型只是在文字里提到该工具名"或"模型改调了别的工具"的响应也扣住，
         * 结果扣错了响应（该次运行写入从未发生，最终 status=blocked /
         * permissionAsk=requires-human-resubmission）。必须解析 tool_calls。
         */
        const requestedToolNames = extractRequestedToolNames(upstreamBody);
        requestedToolNamesByRequest.push(requestedToolNames);
        upstreamResponseTexts.push(upstreamBody);
        const shouldHold = requestedToolNames.includes(holdMarker) && !isHumanEditDetected;
        if (shouldHold) {
          heldResponseCount += 1;
        }
        options.onUpstreamResponse?.({
          requestIndex: currentRequestIndex,
          requestedToolNames,
          wasHeld: shouldHold,
          responseBody: upstreamBody,
        });
        if (shouldHold) {
          await waitForHumanEdit();
        }
        outgoingResponse.writeHead(upstreamStatus, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        outgoingResponse.end(upstreamBody);
      })();
    });
  });

  /**
   * **必须关闭 Node http.Server 的默认超时**（2026-10-09 实测踩到）：
   * Node 默认 `requestTimeout = 300000ms`（5 分钟），而本代理要按人工编辑窗口
   * （可长达 30 分钟）扣住响应——超时一到 Node 会**直接销毁 socket**，
   * CLI 侧表现为 `Provider 请求失败或超时`，窗口白开。
   * 证据：窗口 12:21:48 开启，CLI 于 12:27:25（≈5 分钟后）报请求失败，
   * 而用户恰在该秒完成编辑 → `humanEditDetected=false`。
   */
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 0;

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    endpoint: "http://127.0.0.1:" + String(port) + "/v1/chat/completions",
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
    getRequestCount: () => requestCount,
    getRequestBodyTexts: () => [...requestBodyTexts],
    getUpstreamResponseTexts: () => [...upstreamResponseTexts],
    getRequestedToolNamesByRequest: () => requestedToolNamesByRequest.map((names) => [...names]),
    wasHumanEditDetected: () => isHumanEditDetected,
    getDetectedHumanContent: () => detectedHumanContent,
    getHeldResponseCount: () => heldResponseCount,
    /** 供自测断言"默认 5 分钟 requestTimeout 确已关闭"（否则长窗口必被销毁）。 */
    getServerTimeoutMilliseconds: () => ({
      requestTimeout: server.requestTimeout,
      headersTimeout: server.headersTimeout,
      timeout: server.timeout,
      keepAliveTimeout: server.keepAliveTimeout,
    }),
  };
}
