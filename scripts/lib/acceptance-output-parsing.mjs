/**
 * 真实验收脚本的输出解析工具（T07D-R2-04，2026-10-02）。
 *
 * 背景（实测缺陷）：CLI 的 `--json` 输出是**多行**的，原先按
 * `stdoutText.trim().split("\n").at(-1)` 解析必然失败（末行只是 `}`），
 * 会把本该通过的真实验收误判为失败。这里按大括号配平提取，
 * 并正确忽略字符串内的括号与转义。
 */

/** 从文本中提取**首个完整 JSON 对象**；无法配平或不存在时返回 null。 */
export function extractFirstJsonObject(text) {
  const startIndex = text.indexOf("{");
  if (startIndex < 0) {
    return null;
  }
  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === '"') {
        isInsideString = false;
      }
      continue;
    }
    if (character === '"') {
      isInsideString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }
  return null;
}

/** 解析首个完整 JSON 对象；无法解析时返回 null（不抛错，供验收脚本判定失败）。 */
export function parseFirstJsonObject(text) {
  const candidate = extractFirstJsonObject(text);
  if (candidate === null) {
    return null;
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** 按行比较用：丢弃行尾 \r 与末尾空行（结尾换行不敏感）。 */
export function toComparableLines(text) {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
