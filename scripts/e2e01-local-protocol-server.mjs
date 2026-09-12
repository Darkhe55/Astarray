#!/usr/bin/env node
/**
 * E2E-01 本地协议服务器（OpenAI Chat Completions 兼容，SSE 流式）。
 *
 * 用途：在无真实凭据的离线环境里，从公共入口（CLI/SDK）验证 Provider 运行时接线。
 * 只提供确定性响应，不访问网络、不产生费用。
 * 用法：node scripts/e2e01-local-protocol-server.mjs [--port 0] [--model fake-model]
 * 输出：{"endpoint":"http://127.0.0.1:<port>/v1/chat/completions","model":"..."}
 */
import http from "node:http";

function parseArguments(argumentsList) {
  const options = { port: 0, model: "fake-model" };
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === "--port") {
      options.port = Number.parseInt(argumentsList[index + 1] ?? "0", 10);
      index += 1;
    } else if (argumentsList[index] === "--model") {
      options.model = argumentsList[index + 1] ?? options.model;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
let requestCount = 0;

function completionMarkerLine() {
  return (
    "ASTARRAY_TASK_COMPLETION_V1 " +
    JSON.stringify({
      taskExecutionId: "task-exec:local-protocol-server",
      completionAttemptId: "attempt-local-1",
      completedTaskIdentifiers: ["T-001"],
      claimedStatus: "complete",
      taskSequenceRevision: 1,
    })
  );
}

function writeSseChunk(response, delta, finishReason) {
  response.write(
    "data: " +
      JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] }) +
      "\n\n",
  );
}

const server = http.createServer((request, response) => {
  let rawBody = "";
  request.on("data", (chunk) => {
    rawBody += String(chunk);
  });
  request.on("end", () => {
    requestCount += 1;
    let requestedModel = options.model;
    try {
      const body = JSON.parse(rawBody);
      if (typeof body.model === "string" && body.model !== "") {
        requestedModel = body.model;
      }
    } catch {
      // 非法 JSON：按默认模型回答，交由适配器判定
    }
    console.log(
      JSON.stringify({
        event: "request",
        requestIndex: requestCount,
        path: request.url,
        model: requestedModel,
      }),
    );
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    writeSseChunk(response, { role: "assistant" }, null);
    writeSseChunk(
      response,
      { content: "本地协议服务器已完成任务。\n" + completionMarkerLine() },
      "stop",
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });
});

server.listen(options.port, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  console.log(
    JSON.stringify({
      endpoint: "http://127.0.0.1:" + port + "/v1/chat/completions",
      model: options.model,
    }),
  );
});

const shutdown = () => {
  server.close(() => {
    console.log(JSON.stringify({ event: "closed", requestCount }));
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
