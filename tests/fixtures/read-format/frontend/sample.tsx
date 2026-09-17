import React from "react";
import {
  useState,
  useEffect,
} from "react";
import "./styles.css";

// 普通注释
export function Widget() {
  const [count, setCount] = useState(0);
  const url = "https://example.com/a//b";
  const template = `value: ${count} // not a comment`;
  const regex = /https?:\/\/example\.com\/\w+/;
  const ratio = count / 2 / 3;
  const el = (
    <div data-url="https://example.com/x//y">
      // JSX 文本里的双斜杠不是注释
      {/* 真正的 JSX 注释 */}
      <span>{count /* 表达式内注释 */}</span>
    </div>
  );
  const dynamicModule = () => import("./dynamic.js");
  return { el, dynamicModule, ratio, regex, template, url };
}
