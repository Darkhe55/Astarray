import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "packages/tui/src/cli.tsx",
    "feedback-process-entry": "packages/core/src/feedback-process/child-bootstrap.ts",
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
