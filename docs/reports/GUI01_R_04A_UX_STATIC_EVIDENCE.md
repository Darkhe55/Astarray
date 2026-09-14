# GUI-01-R-04a 用户体验自动断言与打包就绪 — 证据

> 检查点：GUI-01-R-04（04a，docs/tasks/GUI01_R_PRODUCT_WORKBENCH_TASK_CARD.md）
> 前驱：GUI-01-R-03（done）。日期：2026-09-13
> 人工体验与真实安装包实跑：见 docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md（未执行，04b）

## 1. 本轮范围

GUI-01-R-04 要求"键盘、中文、缩放、可访问性、断线恢复与资源观察；从安装包打开 GUI"，
验收明确"自动截图或 DOM 断言不能替代人工体验结论"。因此本轮拆分为：

- **04a（done）**：把可自动化的部分做实并留证据——页面可访问性的静态契约、离线自足（无外部资源/无未净化 HTML）、关闭时的资源回收（订阅取消、SSE 结束、端口释放）；同时产出人工验收清单与打包命令清单。
- **04b（pending/blocked）**：真实用户人工体验结论、从 tarball 隔离安装打开 GUI、Linux/macOS 平台证据。依赖人工与完整访问（受限沙箱下打包/安装命令 `spawn EPERM`）。

## 2. 实现与测试

| 文件 | 内容 |
| --- | --- |
| `tests/gui/integration/gui-ux-accessibility.test.ts`（新，3 用例） | 语言/视口/配色方案 + 无外部资源 + 无 `innerHTML`；表单控件 `label for` 关联与 `aria-live` 动态区、按钮显式 `type=button`；关闭时取消订阅、结束 SSE、端口可重用 |

命令与结果：`npx tsc --noEmit` 0；`npx eslint .` 0；`npx vitest run tests/gui` **35 passed**（7 文件）。

## 3. 打包验收命令（未执行，待完整访问）

```powershell
npm run check
npm pack
node scripts/verify-package.mjs <本次生成的tarball实际路径>
node scripts/smoke-install.mjs
```

本轮以 `danger-full-access` 尝试执行上述命令 + `test:coverage` 共 2 次，审批通道均等待 600s 超时、命令未执行（记录在案，**不计为通过**）。

## 5. 提交与推送

- 实现提交：`b35cc9f` `feat(gui): GUI-01-R-04a 可访问性静态契约与关闭时资源回收`（4 文件，+274/−4；用户并行改动未暂存）。
- 推送：`git push` 受限沙箱失败（`couldn't create signal pipe`，exit 128）；升级重试因审批通道不可用未执行 → 累积待推送（自 `b5e3be1` 起共 7 个提交）。

## 4. 未满足项（不声称已验收）

- 真实用户人工体验结论（键盘、中文输入法、200% 缩放、深色模式与屏幕阅读器、断线恢复、资源观察）→ 04b。
- 从 tarball 隔离安装打开 GUI → 04b（需完整访问）。
- Linux/macOS → 未验证。
