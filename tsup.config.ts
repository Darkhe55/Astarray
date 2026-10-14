import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "packages/tui/src/cli.tsx",
    "feedback-process-entry": "packages/core/src/feedback-process/child-bootstrap.ts",
    "public-sdk": "packages/core/src/public-sdk.ts",
    /**
     * GUI-02-04（2026-11-08）：GUI 必须有公开入口。
     * 此前 `packages/gui` 只被打进内部 chunk、且不在 `package.json` 的 `exports` 里
     * ⇒ 消费者装上隔离 tarball 也拿不到 GUI，卡内"隔离 tarball 打开 GUI 复验"无法成立。
     */
    "public-gui": "packages/gui/src/public-gui.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  external: ["ink", "react", "react-dom"],
});
