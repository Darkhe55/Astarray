/**
 * READ-FORMAT-05b：安装包离线可用与资源测量验证。
 *
 * 用法：node scripts/verify-read-format-package.mjs --package-dir <已安装包目录> [--iterations N]
 * 断言：只用安装包导出的公共 SDK（dist/public-sdk.js）完成读取视图过滤/回执/未支持/parse-error，
 *       并测量解析耗时、峰值堆增量与返回量。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

const packageDirectoryPath = readArgument("--package-dir", null);
if (packageDirectoryPath === null) {
  console.error("用法: node scripts/verify-read-format-package.mjs --package-dir <已安装包目录>");
  process.exit(2);
}
const iterationCount = Number.parseInt(readArgument("--iterations", "200"), 10);

const publicSdkPath = path.join(packageDirectoryPath, "dist", "public-sdk.js");
const { defaultReadFormatStrategyRegistry } = await import(
  pathToFileURL(publicSdkPath).href,
);

const sampleCSource = [
  "#include <stdio.h>",
  "// 注释",
  'const char *marker = "// not a comment";',
  "#define MAX_COUNT 42 /* 宏内注释 */",
  "",
].join("\n");
const samplePythonSource = [
  "# 注释",
  '"""文档字符串：包含 # 井号"""',
  "import os",
  'text = "# 字符串里的井号"',
  "",
].join("\n");
const sampleRustSource = [
  "// 行注释",
  "/* 外层 /* 嵌套 */ 仍在注释 */",
  'let raw = r#"// raw 不是注释"#;',
  "use std::fmt;",
  "",
].join("\n");
const unknownSource = "// not filtered\n";
const incompleteSource = "#include <stdio.h>\n/* unterminated\n";

function buildView(filePath, sourceText, shouldIncludeComments, shouldIncludeImports) {
  return defaultReadFormatStrategyRegistry.buildReadView({
    filePath,
    sourceText,
    shouldIncludeComments,
    shouldIncludeImports,
    isSensitiveCheckApplied: true,
  });
}

const problems = [];
function assertCondition(condition, message) {
  if (!condition) {
    problems.push(message);
  }
}

const cCommentsOff = buildView("sample.c", sampleCSource, false, true);
assertCondition(
  cCommentsOff.filterStatus === "filtered" ||
    cCommentsOff.filterStatus === "partially-filtered",
  "C 注释过滤状态应为 filtered/partially-filtered（宏内注释按策略保留）",
);
assertCondition(!cCommentsOff.viewText.includes("// 注释"), "C 行注释应被省略");
assertCondition(cCommentsOff.viewText.includes('"// not a comment"'), "字符串里的双斜杠应保留");
assertCondition(cCommentsOff.viewText.includes("#define MAX_COUNT 42"), "宏应保留");
assertCondition(cCommentsOff.omittedLineRanges.length > 0, "应记录省略行区间");

const cImportsOff = buildView("sample.c", sampleCSource, true, false);
assertCondition(!cImportsOff.viewText.includes("#include <stdio.h>"), "include 应被省略");
assertCondition(cImportsOff.viewText.includes("// 注释"), "保留注释时注释应存在");

const pythonView = buildView("sample.py", samplePythonSource, false, true);
assertCondition(pythonView.viewText.includes('"""文档字符串：包含 # 井号"""'), "Python 文档字符串应保留");
assertCondition(!pythonView.viewText.includes("# 注释"), "Python 行注释应被省略");
assertCondition(pythonView.viewText.includes('text = "# 字符串里的井号"'), "Python 字符串里的井号应保留");

const rustView = buildView("sample.rs", sampleRustSource, false, true);
assertCondition(!rustView.viewText.includes("嵌套"), "Rust 嵌套块注释应整体省略");
assertCondition(rustView.viewText.includes('r#"// raw 不是注释"#'), "Rust 原始字符串应保留");

const unknownView = buildView("sample.xyz", unknownSource, false, false);
assertCondition(unknownView.filterStatus === "unsupported", "未支持格式应标 unsupported");
assertCondition(unknownView.isFilterable === false, "未支持格式不可过滤");
assertCondition(unknownView.viewText === unknownSource, "未支持格式应原样返回");

const incompleteView = buildView("incomplete.c", incompleteSource, false, false);
assertCondition(incompleteView.filterStatus === "parse-error", "未闭合源码应报 parse-error");
assertCondition(incompleteView.viewText === incompleteSource, "parse-error 应原样返回");

const receiptCheck = buildView("sample.c", sampleCSource, false, false);
assertCondition(typeof receiptCheck.sourceHash === "string" && receiptCheck.sourceHash.length === 64, "回执应含 sha256 源哈希");
assertCondition(receiptCheck.sensitiveCheckAppliedBeforeView === true, "回执应标明敏感检查先于视图");
assertCondition(receiptCheck.budgetImpact === "same-file", "回执应标明不新增文件槽");
assertCondition(
  receiptCheck.measuredUnits === Buffer.byteLength(receiptCheck.viewText, "utf8"),
  "measuredUnits 应等于视图 utf8 字节数",
);

const fixtures = [
  ["sample.c", sampleCSource],
  ["sample.py", samplePythonSource],
  ["sample.rs", sampleRustSource],
  ["sample.xyz", unknownSource],
  ["incomplete.c", incompleteSource],
];
const heapBeforeBytes = process.memoryUsage().heapUsed;
let peakHeapBytes = heapBeforeBytes;
let totalOutputBytes = 0;
const startedAtNanoseconds = process.hrtime.bigint();
for (let iteration = 0; iteration < iterationCount; iteration += 1) {
  for (const [filePath, sourceText] of fixtures) {
    const view = buildView(
      filePath,
      sourceText,
      iteration % 2 === 0,
      iteration % 3 === 0,
    );
    totalOutputBytes += Buffer.byteLength(view.viewText, "utf8");
    const currentHeapBytes = process.memoryUsage().heapUsed;
    if (currentHeapBytes > peakHeapBytes) {
      peakHeapBytes = currentHeapBytes;
    }
  }
}
const elapsedMilliseconds =
  Number(process.hrtime.bigint() - startedAtNanoseconds) / 1_000_000;
const viewCount = iterationCount * fixtures.length;
const averageMillisecondsPerView = elapsedMilliseconds / viewCount;
const heapDeltaBytes = peakHeapBytes - heapBeforeBytes;
const inputBytes = fixtures.reduce(
  (total, [, sourceText]) => total + Buffer.byteLength(sourceText, "utf8"),
  0,
);

assertCondition(elapsedMilliseconds < 30_000, "资源测量总耗时超出上限");
assertCondition(averageMillisecondsPerView < 20, "单次视图构造平均耗时超出上限");
assertCondition(heapDeltaBytes < 128 * 1024 * 1024, "峰值堆增量超出上限");

if (problems.length > 0) {
  console.error("READ-FORMAT 包级校验失败:");
  for (const problem of problems) {
    console.error("  - " + problem);
  }
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      packageDirectoryPath,
      nodeVersion: process.version,
      platform: process.platform,
      fixtureCount: fixtures.length,
      inputBytesPerRound: inputBytes,
      iterationCount,
      viewCount,
      elapsedMilliseconds: Math.round(elapsedMilliseconds * 100) / 100,
      averageMillisecondsPerView:
        Math.round(averageMillisecondsPerView * 10_000) / 10_000,
      peakHeapDeltaBytes: heapDeltaBytes,
      totalOutputBytes,
      isOffline: true,
    },
    null,
    2,
  ),
);
