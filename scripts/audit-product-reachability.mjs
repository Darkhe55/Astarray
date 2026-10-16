/**
 * 产品可达性勘测（2026-11-08，第 106 轮）。
 *
 * ## 为什么有这个脚本
 *
 * 本会话接连抓到三处**同类**缺口：`PERF` 采集、`DIAG` 采集、**T08 编排层 Git 集成整层**
 * —— 都是"**有实现、有测试，但产品里没有入口**"。与其逐个人工猜，不如机械枚举候选再人工分诊。
 *
 * ## 口径（三轮修订后的版本；**启发式，必须抽查**）
 *
 * 候选 = `packages/core/src` 里 `export class X`，且同时满足：
 *   ① **生产构造点为 0**（在**全部**生产文件里搜 `new X(` —— **含定义文件自身**，
 *      因为"同文件另一个类构造它"属于**可达**）；
 *   ② **生产提及为 0**（按**模块路径**搜 import/引用，而不是按类名 —— 类名会漏掉"只 import 常量"的情形）；
 *   ③ **测试里至少构造一次**（说明它确实需要被构造，不是纯类型）；
 *   ④ 名字属于"能力型"后缀（Store/Service/Controller/Guard/... ）且不在纯类型后缀白名单里。
 *
 * ## ⚠️ 已知局限（我必须如实写明，避免把启发式当结论）
 *
 * - **子类化**：生产里若 `class Y extends X` 并 `new Y(`，则 X 被判为"无构造" ⇒ **假阳性**；
 * - **工厂/间接构造**：`X.create()`／`Object.create(X.prototype)` 等写法搜不到 `new X(` ⇒ 可能假阳性；
 * - **公开导出**：脚本会额外标注"是否被 `public-sdk` 提及" —— 被导出者**可由宿主注入**，
 *   属"可达但需宿主提供"，与"完全不可达"**不同**，分诊时必须区分；
 * - ⇒ **每个候选都要用 `grep` 人工抽查后才能下结论**（本脚本只负责**缩小范围**）。
 *
 * 用法：`node scripts/audit-product-reachability.mjs`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function walk(directory, extensions, accumulator = []) {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "dist") continue;
    const fullPath = path.join(directory, name);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, extensions, accumulator);
    } else if (extensions.some((extension) => name.endsWith(extension))) {
      accumulator.push(fullPath.replace(/\\/g, "/"));
    }
  }
  return accumulator;
}

const productionEntries = walk("packages", [".ts"]).map((filePath) => ({
  filePath,
  text: readFileSync(filePath, "utf8"),
}));
const testEntries = walk("tests", [".ts"]).map((filePath) => ({
  filePath,
  text: readFileSync(filePath, "utf8"),
}));
const publicSdkEntry = productionEntries.find((entry) =>
  entry.filePath.endsWith("packages/core/src/public-sdk.ts"),
);

/** 能力型后缀（只保留这些，减少噪声）。 */
const capabilitySuffixes = [
  "Store",
  "Service",
  "Controller",
  "Coordinator",
  "Guard",
  "Engine",
  "Manager",
  "Registry",
  "Ledger",
  "Resolver",
  "Planner",
  "Scheduler",
  "Supervisor",
  "Allocator",
  "Verifier",
  "Observer",
  "Ingestor",
  "Projection",
  "Catalog",
  "Policy",
  "Client",
  "Runtime",
  "Driver",
];

const classes = [];
for (const entry of productionEntries) {
  if (!entry.filePath.includes("packages/core/src/")) continue;
  for (const match of entry.text.matchAll(/export class ([A-Z][A-Za-z0-9_]*)/g)) {
    classes.push({ name: match[1], definedIn: entry.filePath });
  }
}

const candidates = [];
for (const { name, definedIn } of classes) {
  if (!capabilitySuffixes.some((suffix) => name.endsWith(suffix))) continue;

  const constructionCount = productionEntries.reduce((total, entry) => {
    const matches = entry.text.match(new RegExp("new\\s+" + name + "\\s*\\(", "g"));
    return total + (matches === null ? 0 : matches.length);
  }, 0);
  if (constructionCount > 0) continue;

  /** 按**模块路径**统计生产提及（不含定义文件自身）。 */
  const moduleStem = path.basename(definedIn).replace(/\.ts$/, "");
  const mentionCount = productionEntries
    .filter((entry) => !entry.filePath.endsWith(definedIn))
    .reduce((total, entry) => {
      const matches = entry.text.match(new RegExp(moduleStem + "\\.js", "g"));
      return total + (matches === null ? 0 : matches.length);
    }, 0);

  const testConstructionCount = testEntries.reduce((total, entry) => {
    const matches = entry.text.match(new RegExp("new\\s+" + name + "\\s*\\(", "g"));
    return total + (matches === null ? 0 : matches.length);
  }, 0);
  if (testConstructionCount === 0) continue;

  const isMentionedByPublicSdk =
    publicSdkEntry !== undefined &&
    new RegExp("\\b" + name + "\\b").test(publicSdkEntry.text);

  candidates.push({
    name,
    definedIn,
    productionMentionCount: mentionCount,
    testConstructionCount,
    isMentionedByPublicSdk,
  });
}

candidates.sort((left, right) => {
  if (left.productionMentionCount !== right.productionMentionCount) {
    return left.productionMentionCount - right.productionMentionCount;
  }
  return left.name.localeCompare(right.name);
});

console.log("候选数 = " + String(candidates.length) + "（按「生产提及」升序；提及为 0 者最可疑）");
console.log(
  "  " + "名称".padEnd(42) + "生产提及  测试构造  门面提及  定义文件",
);
for (const candidate of candidates) {
  console.log(
    "  " +
      candidate.name.padEnd(42) +
      String(candidate.productionMentionCount).padStart(6) +
      String(candidate.testConstructionCount).padStart(10) +
      "  " +
      (candidate.isMentionedByPublicSdk ? "是" : "否").padEnd(8) +
      "  " +
      candidate.definedIn.replace("packages/core/src/", ""),
  );
}
