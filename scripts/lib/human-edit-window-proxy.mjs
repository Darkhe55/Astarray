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
        if (upstreamBody.includes(holdMarker) && !isHumanEditDetected) {
          heldResponseCount += 1;
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
    wasHumanEditDetected: () => isHumanEditDetected,
    getDetectedHumanContent: () => detectedHumanContent,
    getHeldResponseCount: () => heldResponseCount,
  };
}
