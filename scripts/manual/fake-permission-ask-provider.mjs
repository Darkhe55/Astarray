/**
 * 手动验收用**最小假 Provider**（GUI-02-01 片④ 的 TTY 权限询问实验）。
 *
 * 为什么需要它：`mock` 运行时**不会请求受限工具**，所以权限询问永远不会被触发
 * （本会话实测结论）；而真实大模型是否请求受限工具**不确定**。
 * 本脚本是一个**本地 OpenAI 兼容端点**，它**只做一件事**：返回一次
 * `createProjectFile` 工具调用 —— 从而**确定性地**触发权限询问。
 *
 * 用法（两个终端）：
 *   终端 1：node scripts/manual/fake-permission-ask-provider.mjs
 *   终端 2：node dist/cli.js run "创建 .tmp/tty-check.md，内容写 # TTY 检查" \
 *             --mode assist --runtime openai-compatible \
 *             --provider-endpoint http://127.0.0.1:48771/v1/chat/completions \
 *             --provider-model fake-model --json
 *
 * **注意**：终端 2 必须带 `--json`（非 TTY 下 `run` 的既定要求），
 * 并在**真实终端**（有 TTY）中运行才能看到交互提示。
 *
 * 本脚本**不读取、不打印、不存储任何密钥**，仅监听 127.0.0.1。
 */
import http from "node:http";

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 48771);
const filePath = process.env.FAKE_PROVIDER_FILE_PATH ?? ".tmp/tty-check.md";
const content = process.env.FAKE_PROVIDER_CONTENT ?? "# TTY 检查\n";

function sseToolCall(argumentsJson, callId) {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: "createProjectFile", arguments: argumentsJson },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    "\n\n" +
    "data: " +
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
    "\n\n" +
    "data: [DONE]\n\n"
  );
}

function sseCompletion() {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            role: "assistant",
            content: "已完成。",
          },
          finish_reason: "stop",
        },
      ],
    }) +
    "\n\n" +
    "data: [DONE]\n\n"
  );
}

let requestIndex = 0;
const server = http.createServer((request, response) => {
  request.on("data", () => {});
  request.on("end", () => {
    requestIndex += 1;
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    /**
     * 只**第一次**返回受限工具调用：随后给出完成事件，避免无限重调同一工具
     * （与既有 harness 的夹具行为一致）。
     */
    if (requestIndex === 1) {
      response.write(
        sseToolCall(
          JSON.stringify({ filePath, content }),
          "manual-call-1",
        ),
      );
    } else {
      response.write(sseCompletion());
    }
    response.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `假 Provider 已就绪：http://127.0.0.1:${port}/v1/chat/completions\n` +
      `它将返回一次 createProjectFile 调用：filePath=${filePath}\n` +
      `请在**另一个终端**运行（注意 --json）：\n` +
      `  node dist/cli.js run "创建 ${filePath}" --mode assist --runtime openai-compatible ` +
      `--provider-endpoint http://127.0.0.1:${port}/v1/chat/completions ` +
      `--provider-model fake-model --json\n` +
      `（本进程 Ctrl+C 结束；未读取任何密钥。）\n`,
  );
});
