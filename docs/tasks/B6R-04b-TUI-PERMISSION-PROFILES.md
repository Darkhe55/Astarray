# B6R-04b：TUI 权限组控制面（B6R-04 后继卡）

> 状态：待执行
> 编制日期：2026-08-16
> 适用提交：`5609ed1`（B6R-04 CLI 控制面已完成）
> 对应整改项：AR-06F / AR-06G
> 执行主体：OpenCode、受控次级 Agent 与受控三级 Agent
> 拆卡原因：B6R-04 生产文件已达 8 个上限，TUI 编辑页独立成卡，遵守"一次一张卡"纪律。

## 1. 目标

B6R-04 已交付 Headless CLI 完整权限组生命周期。本卡把同一认证设置控制面接入 TUI：
权限组列表/详情、当前组切换、创建/复制/重置/删除入口与逐项三态查看；
头栏显示当前权限组；不把设置控制器暴露为 Agent 工具。

## 2. 任务链

1. `MainController` 增加只读控制面方法：`getCurrentPermissionProfileReference()`、
   `listPermissionProfiles()`、`switchPermissionProfile(reference)`（认证设置控制面，
   非模型工具）。
2. `bootstrapCli` 装配 `CurrentPermissionSelectionStore` 并把当前引用传入 TUI 状态。
3. `AppState` 增加 `permissionProfileReference` 与 `permissionProfiles` 字段；
   状态轮询只读刷新（不打断输入）。
4. TUI 头栏显示当前权限组（显示名快照）；新增权限组面板（分页/虚拟列表、
   当前组标记、Unicode 长名称、搜索过滤）。
5. 面板内操作入口：切换当前组、创建（来源选择）、复制、重置、删除（当前组
   保护提示）——经认证控制面调用，不新增 Agent 工具。
6. 组件测试覆盖 80×24、120×40、60×20 尺寸、CJK/emoji 长名称、搜索与分页。

## 3. 完成条件

- 安装 tarball 后 TUI 可查看并切换当前权限组；重启后 ID/revision 保持。
- 面板不显示内部执行层、不显示 Ponder 编辑控件；Ponder 仅作为不可编辑选择项。
- 设置控制器不作为 Agent 工具注册；Agent 无法调用权限组控制面。
- 尺寸/长名称/搜索/分页组件测试通过；`npm run check` 通过。

## 4. 统一交付格式

按 `BATCH6_REPAIR_TASK_CARDS.md` §5 交付 `ASTARRAY_TASK_COMPLETION_V1`，
附 changedProductionFiles/changedTestFiles/executedChecks/coverageEvidence/
remainingRisks/completionGate。

## 5. 禁止事项

- 不修改 B6R-01~04 已验收行为；不引入新的数量配额或内部执行层披露。
- 不把设置控制面注册为模型工具；headless 契约维持不变。
