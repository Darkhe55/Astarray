// T07D-R1-04 消费者场景：只使用包公开 exports（"astarray"），不导入源码路径。
import { readFileSync, readdirSync, existsSync } from "node:fs";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const stateDirectory = process.cwd() + "/state";
const sdk = await import("astarray");
const application = await sdk.AstarrayApplicationFacade.create({
  stateDirectory,
  mode: "assist",
  statusPollIntervalMilliseconds: 10,
});
application.createSession({ sessionId: "s1", mode: "assist" });
const accepted = await application.submitTask({
  sessionId: "s1",
  taskIdentifier: "t1",
  prompt: "T07D-R1-04 consumer",
  idempotencyKey: "idem-consumer",
});
const duplicate = await application.submitTask({
  sessionId: "s1",
  taskIdentifier: "t1-dup",
  prompt: "T07D-R1-04 consumer",
  idempotencyKey: "idem-consumer",
});

let queried;
const deadline = Date.now() + 5000;
while (true) {
  queried = await application.queryTask({ sessionId: "s1", taskIdentifier: "t1" });
  if (["done", "failed", "cancelled", "blocked"].includes(queried.status) || Date.now() > deadline) {
    break;
  }
  await sleep(10);
}

const taskChainPath =
  stateDirectory + "/missions/" + accepted.missionIdentifier + "/task-chain.json";
const taskChainText = existsSync(taskChainPath) ? readFileSync(taskChainPath, "utf8") : "";

// 取消路径
await application.submitTask({
  sessionId: "s1",
  taskIdentifier: "t2",
  prompt: "cancel path",
});
await application.cancelTask({ sessionId: "s1", taskIdentifier: "t2" });
const cancelled = await application.queryTask({ sessionId: "s1", taskIdentifier: "t2" });

let internalSubpathBlocked = false;
try {
  await import("astarray/dist/cli.js");
} catch {
  internalSubpathBlocked = true;
}
await application.shutdown();
await sleep(200);

console.log(
  JSON.stringify({
    sdkVersion: sdk.ASTARRAY_SDK_VERSION,
    acceptedStatus: accepted.status,
    idempotentMissionMatched: duplicate.missionIdentifier === accepted.missionIdentifier,
    finalStatus: queried.status,
    summaryPreview: queried.summaryPreview,
    taskChainContainsDone: taskChainText.includes("done"),
    taskChainContainsTask: taskChainText.includes("T-001"),
    cancelObservedStatus: cancelled.status,
    missionCount: readdirSync(stateDirectory + "/missions").length,
    internalSubpathBlocked,
    closedAfterShutdown: application.isClosed,
  }),
);
