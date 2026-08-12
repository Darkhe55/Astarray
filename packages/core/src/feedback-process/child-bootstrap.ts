/**
 * 真实进程引导（T04 附加）。
 * 与 cli.tsx 同类：仅在被 fork 的真实 Node 进程中执行的入口粘合代码，
 * 不参与单元/集成覆盖统计（vitest coverage exclude）。
 */
import { isNodeJsProcess } from "./entrypoint.js";
import { runFeedbackProcessEntry } from "./entrypoint.js";

if (
  isNodeJsProcess(process) &&
  process.env.ASTARRAY_FEEDBACK_CHILD === "1" &&
  typeof process.send === "function"
) {
  runFeedbackProcessEntry(
    process as unknown as import("./entrypoint.js").ChildProcessLike,
    {
      defaultBaseDirectory: process.env.ASTARRAY_STATE_DIRECTORY ?? ".astarray",
    },
  );
}
