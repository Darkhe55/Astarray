# GUI 权限组切换接受不存在的自定义权限组（缺陷发现，2026-09-19）

> 发现方式：GUI-01-R-04b 安装产物级校验中的行为反例（`scripts/verify-gui-sse-reconnect.mjs`）
> 已复现提交：`f1f52ec` 之上；被测产物：tarball sha256 `a45ae4da…d1f`（隔离安装）
> 状态：**已复现、未修复**。修复需授权（见 §4）。

## 1. 反例（实测）

```
POST /commands/switch-permission-profile
  x-csrf-token: <有效>
  {"kind":"custom","profileId":"custom-does-not-exist"}
→ 200 {"status":"switched","reference":{"kind":"custom","profileId":"custom-does-not-exist"}}
```

随后 `GET /settings` 的 `permissionProfiles.current` 即为该不存在的引用——**公共入口对不存在的自定义权限组返回成功并持久化悬空引用**。

## 2. 代码路径（已核对）

| 层 | 位置 | 行为 |
| --- | --- | --- |
| GUI 路由 | `packages/gui/src/server/gui-server.ts:835-868` | 只校验 `kind` 与内置白名单（ponder/assist/devolve）；`custom` 只校验非空字符串，随后直接调用并回 200 |
| 公共 SDK | `packages/core/src/public-sdk.ts:846-847` | 直接转调控制器，无校验 |
| 控制器 | `packages/core/src/orchestration/main-controller.ts:333-343` | 读取当前选择后**直接持久化**传入引用，不查询权限组是否存在 |
| 选择存储 | `packages/core/src/tools/current-permission-selection.ts:16-25, 73-94` | schema 允许任意非空 `custom.profileId`；仅做 revision 校验 |
| 解析侧 | `packages/core/src/tools/permission-profile-store.ts:172-186` | 自定义组不存在时抛 `DomainError("task-sequence-not-found", "权限组不存在: …")` |

## 3. 影响与严重度

- **无权限放大证据**：解析侧在缺失时抛错（fail-closed），本轮未观察到任何"放行"路径。
- **真实产品缺陷**：
  1. 界面/接口对不存在的权限组**报成功**，用户以为已切换；
  2. 悬空引用被**持久化**（`settings/permission-profile-current.json`），后续任何解析该引用的路径（会话提升基础决定、会话关闭导出、以及按当前选择装配 profile 的路径）会以内部错误失败；
  3. 报错码 **`task-sequence-not-found`** 用于"权限组不存在"，语义错误（疑似复制粘贴遗留），会误导排障；
  4. 修复前的爆炸半径（只在提升/导出路径失败，还是也会影响装配）本轮**未完全追踪**，需在修复检查点一并确认。

## 4. 建议的最小修复（待授权）

1. `MainController.switchPermissionProfile`：持久化前用 `permissionProfileStore.readProfile(reference)` 做存在性校验；内置组天然合法，自定义组不存在则抛出稳定错误码（建议新增 `permission-profile-not-found`，替换当前误用的 `task-sequence-not-found`）。
2. GUI 路由：把该错误映射为 `404 {"error":"permission-profile-not-found"}`（与既有 `409 stale-revision`、`400 invalid-arguments` 并列），并在响应体不泄漏内部路径。
3. 行为反例（先红后绿）：控制器级单测（不存在 → 拒绝且不写盘；存在 → 成功且 revision 递增）+ GUI 路由级测试（不存在 → 404）+ 保留 `stale-revision` 409 与 CSRF 403；随后在 `verify-gui-sse-reconnect.mjs` 把当前"缺陷观察"断言改为"应被拒绝"。
4. 覆盖率：`permission-profile-store`、`current-permission-selection`、`configurable-permission-policy-engine` 属 22 个安全关键模块（分支 ≥95%），改动后须跑 `npm run check`、`vitest run --coverage` 与 `verify:security-coverage`。

## 5. 当前脚本中的记录方式

`scripts/verify-gui-sse-reconnect.mjs` 保留一项**明确标注为"缺陷观察"**的断言，锁定当前 200 行为以便修复后改为"应被拒绝"；其余 19 项为期望行为断言。
