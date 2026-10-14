/**
 * GUI-02-04 **包级验收**：隔离 tarball 安装后 **GUI 必须真的能打开**。
 *
 * ## 依据
 *
 * 卡内 GUI-02-04 验收行原文：
 * > `verify-package` / `smoke-install` exit 0；**隔离 tarball 打开 GUI 复验**
 *
 * ## 本脚本补的是什么缺口（实测发现，不是推测）
 *
 * `tsup.config.ts` 的 entry 原本只有 `cli`／`feedback-process-entry`／`public-sdk`
 * ⇒ `packages/gui` 的代码只被打进**内部 chunk**，且 `package.json` 的 `exports`
 * **没有 GUI 条目** ⇒ **消费者装上 tarball 也拿不到 GUI**。
 * 也就是说：在补上公开入口之前，"隔离 tarball 打开 GUI"这句话**根本无法执行**。
 *
 * 流程：
 *  1. `npm pack` 生成 tarball；
 *  2. 在 `.tmp/gui-package-acceptance/<runId>/install` **隔离安装**；
 *  3. 用**已安装包的** `dist/public-gui.js` 真实 `startGuiServer`；
 *  4. 取 `GET /` 页面并断言"是 GUI 页面"，再断言历史区在页面里；
 *  5. 写 `acceptance-verdict.json`（含 tarball 字节数与来源提交，可审计）。
 *
 * 纪律：**不联网、不使用任何 Provider 凭据**；只用本地 loopback。
 *
 * 用法：`node scripts/verify-gui-package.mjs`
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";

import { installTarballIsolated, packTarball, readSourceCommit } from "./lib/package-acceptance-runtime.mjs";

const repositoryRoot = process.cwd();
const verificationRunIdentifier = new Date().toISOString().replace(/[:.]/g, "-");
const acceptanceRoot = path.join(
  repositoryRoot,
  ".tmp",
  "gui-package-acceptance",
  verificationRunIdentifier,
);
const installRoot = path.join(acceptanceRoot, "install");
const packageArchiveRoot = path.join(acceptanceRoot, "packages");

console.log("=== GUI-02-04 包级验收：隔离 tarball 打开 GUI ===");

const tarball = packTarball({
  archiveDirectory: packageArchiveRoot,
  shouldRunPrepack: false,
});
const sourceCommit = readSourceCommit();

installTarballIsolated({
  installDirectory: installRoot,
  packageName: "astarray-gui-acceptance",
  tarballPath: tarball.tarballPath,
});

const installedPackageRoot = path.join(installRoot, "node_modules", "astarray");
const installedGuiEntryPath = path.join(installedPackageRoot, "dist", "public-gui.js");

const checks = [];
function record(checkName, isPassed, detail) {
  checks.push({ checkName, isPassed, detail });
  console.log((isPassed ? "✓ " : "✗ ") + checkName + " — " + detail);
}

// ① 已安装包必须**真的有** GUI 入口产物
record(
  "隔离安装内存在 GUI 入口产物（dist/public-gui.js）",
  existsSync(installedGuiEntryPath),
  installedGuiEntryPath,
);

// ② 已安装包的 exports 必须暴露 "./gui"
let exposedGuiEntry = null;
try {
  const installedPackageJson = JSON.parse(
    await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(installedPackageRoot, "package.json"), "utf8"),
    ),
  );
  exposedGuiEntry = installedPackageJson?.exports?.["./gui"]?.import ?? null;
} catch (error) {
  record("读取已安装包 package.json", false, String(error?.message ?? error));
}
record(
  "已安装包 exports 暴露 \"./gui\"",
  typeof exposedGuiEntry === "string" && exposedGuiEntry.length > 0,
  String(exposedGuiEntry),
);

// ③ 用**已安装包**的入口真实起服务并取页面
let pageText = "";
let httpStatus = 0;
let startedServer = null;
const guiStateDirectory = path.join(installRoot, "gui-state");
mkdirSync(guiStateDirectory, { recursive: true });
try {
  const guiModule = await import(pathToFileURL(installedGuiEntryPath).href);
  startedServer = await guiModule.startGuiServer({
    stateDirectory: guiStateDirectory,
    sessionId: "gui-package-acceptance",
    mode: "assist",
    applicationService: {
      subscribe: () => ({ unsubscribe: () => {} }),
      submitTask: async () => ({
        taskIdentifier: "acceptance-task",
        missionIdentifier: null,
        status: "accepted",
      }),
      cancelTask: async () => {},
    },
  });
  const response = await fetch("http://127.0.0.1:" + String(startedServer.port) + "/");
  httpStatus = response.status;
  pageText = await response.text();
} catch (error) {
  record("从隔离安装启动 GUI", false, String(error?.message ?? error));
}

record("GET / 返回 200", httpStatus === 200, "HTTP " + String(httpStatus));
record(
  "页面确实是 GUI 页面（含标题 Astarray 且声明 zh-CN）",
  pageText.includes("Astarray") && pageText.includes('lang="zh-CN"'),
  "页面字节数 " + String(pageText.length),
);
// ④ GUI-02-03 的历史区必须也在**已安装包**渲染出的页面里
record(
  "已安装包渲染的页面含历史区（history-heading）",
  pageText.includes("history-heading"),
  pageText.includes("history-heading") ? "已含" : "缺失",
);
// ⑤ 只读边界：页面不得加载任何外部资源
record(
  "页面不引用外部资源（离线自足）",
  !/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(pageText),
  "外部 URL 存在性检查",
);

if (startedServer !== null) {
  await startedServer.close();
}

const failedChecks = checks.filter((check) => !check.isPassed);
const verdict = {
  schemaVersion: 1,
  verificationRunIdentifier,
  sourceCommit,
  tarballPath: tarball.tarballPath,
  tarballByteCount: tarball.tarballByteCount,
  isPassed: failedChecks.length === 0,
  checks,
};
writeFileSync(
  path.join(acceptanceRoot, "acceptance-verdict.json"),
  JSON.stringify(verdict, null, 2),
  "utf8",
);

console.log("");
console.log(
  "验收结论: " +
    (verdict.isPassed ? "通过" : "未通过") +
    "（" +
    String(checks.length - failedChecks.length) +
    "/" +
    String(checks.length) +
    " 项）",
);
console.log("判据落盘: " + path.join(acceptanceRoot, "acceptance-verdict.json"));

if (!verdict.isPassed) {
  console.error("未通过项: " + failedChecks.map((check) => check.checkName).join("、"));
  rmSync(installRoot, { recursive: true, force: true });
  process.exit(1);
}
process.exit(0);
