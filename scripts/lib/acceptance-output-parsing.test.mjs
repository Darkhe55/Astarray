/** 纯函数测试（Node 内置 test runner）：真实验收脚本的输出解析。 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFirstJsonObject,
  parseFirstJsonObject,
  toComparableLines,
} from "./acceptance-output-parsing.mjs";

test("多行 JSON 必须可解析（旧实现按末行解析必然失败）", () => {
  const multiLine =
    '{\n  "missionId": "mission-1",\n  "status": "done",\n  "permissionAsk": "allowed-once"\n}\n';
  assert.equal(multiLine.trim().split("\n").at(-1), "}");
  assert.deepEqual(parseFirstJsonObject(multiLine), {
    missionId: "mission-1",
    status: "done",
    permissionAsk: "allowed-once",
  });
});

test("前缀噪声 + 嵌套对象：提取首个完整对象且不越界", () => {
  const text = 'astarray: 日志\n{"outer":{"inner":{"deep":1}},"list":[1,2]}\n尾部\n';
  assert.equal(extractFirstJsonObject(text), '{"outer":{"inner":{"deep":1}},"list":[1,2]}');
});

test("字符串内的括号与转义不得影响配平", () => {
  assert.deepEqual(parseFirstJsonObject('{"text":"}{ \\" }","n":1} 尾部 {别的}'), {
    text: '}{ " }',
    n: 1,
  });
});

test("不完整或非法 JSON 返回 null（不抛错）", () => {
  assert.equal(parseFirstJsonObject("没有对象"), null);
  assert.equal(parseFirstJsonObject('{"未闭合": '), null);
  assert.equal(parseFirstJsonObject('{"bad": }'), null);
});

test("逐行比较：结尾换行不敏感，其余精确", () => {
  assert.deepEqual(toComparableLines("a\r\nb\n\n"), ["a", "b"]);
  assert.deepEqual(toComparableLines("a\nb\n"), ["a", "b"]);
});
