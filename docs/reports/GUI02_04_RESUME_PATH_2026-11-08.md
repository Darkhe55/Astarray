# GUI-02-04 第 49 轮进展：接通**恢复执行入口**（显式 → 对账 → 重新鉴权）

- 提交：`3336620`（第 49 轮）
- 卡：`docs/tasks/GUI02_AUTHORIZATION_AND_HISTORY_VIEW_TASK_CARD.md` → GUI-02-04
- 说明：因卡内 GUI-02-04 单元格已很长（>5KB），本轮进展改为**独立报告**记录，
  卡内只保留指针 —— 避免超长单行单元格被编辑事故截断。

---

## 1. 卡内要求

> **GUI-02-04** | **重启与包级验收** —— 重启后界面不误导（明确"会话视图为空"≠数据丢失）；
> **恢复须显式 + 先对账 + 重新鉴权**；隔离 tarball 打开 GUI 复验

第 47/48 轮已交付：包级验收（公开 GUI 入口 + `verify:gui-package` 6/6）、
重启不误导（空会话视图说明）、恢复闸门契约（`evaluateGuiRecoveryGate`）与恢复区说明。
**本轮把"真正调用核心恢复"的入口接通。**

## 2. 交付

1. **门面方法 `resumeRecoveredMission({ missionIdentifier, hasExplicitUserConfirmation })`**：
   - **第一道门「显式」判在任何核心查找之前**；
   - 第二道门「先对账」依据只读恢复概览的 `reconciliationRequired`；
   - 第三道门「**重新鉴权由核心 `resumeMission` 强制**」—— 一次性授权不随恢复延续会被计为
     阻塞项 ⇒ 未重新鉴权**不可能**得到 `resumed: true`；
   - 核心拒绝时**原样回报**阻塞项与理由，**不美化成"已恢复"**。
2. **`PublicRecoveryMissionView` 增 `requiredReauthorizationTypes`**（沿 mapper 一路补齐），
   使界面能提示"还差重新鉴权"。
3. **GUI 路由 `POST /commands/recovery-resume`**：只接受 POST；**必须**显式确认
   （缺它直接 **400**、**不进核心**）；能力缺失 ⇒ **501**。

## 3. ⚠️ 反例②抓出我一个**真实的顺序错误**（已修）

我最初把「显式确认」判在 **mission 存在性检查之后**。反例②（"未显式确认 + 未知 mission"）
实测返回 `recovery-blocked-by-core`，而不是 `recovery-not-explicitly-confirmed`
⇒ **证明"显式"这道门形同虚设**：用户还没表态，系统已经替他去核心查了一圈。

**修法**：把第一道门提到**方法最开头**、任何核心调用之前。

**这正是"先写行为反例"的价值** —— 这个顺序错误靠读代码看不出来。

## 4. ⚠️ 另一处我**主动改正的空断言**（诚实记录）

初版我在方法里调 `evaluateGuiRecoveryGate` 并传：

```ts
isReauthorizationSatisfied: (missionView.requiredReauthorizationTypes ?? []).length === 0
```

但 `listMissions()` **根本不返回**该字段 ⇒ 它恒为 `0 === 0` = **恒真**
⇒ 那道门**看起来在判、实际永远通过**。

这与本仓库当年在跨项目授权里踩过的坑同类（"测试通过 ≠ 测试有效"）。
**已删掉这个假判定**，改为显式注明：**第三道门由核心强制**，
并写清"为什么不在入口预判"（该信息只有核心分类结果才有，预判只能是假的）。

## 5. 反例 5 条（先红后绿）

`tests/gui/integration/gui02-04-recovery-resume-gate.test.ts`

| # | 反例 | 结果 |
| --- | --- | --- |
| ① | 未显式确认 ⇒ 明确拒绝**且不触碰状态**（前后 `summary.json` 状态一致） | ✓ |
| ② | **显式门在核心查找之前**（对不存在的 mission 也先报"未显式确认"） | ✓ ← **抓到顺序缺陷** |
| ③ | 已确认但 mission 未知 ⇒ 明确拒绝 | ✓ |
| ④ | 无可信检查点 ⇒ 核心拒绝、阻塞项原样回报、状态未被改 | ✓ |
| ⑤ | 已终态 done ⇒ 不得被恢复 | ✓ |

## 6. 门禁（真实退出码）

`typecheck` **0（0 错误）** ｜ `build` **0** ｜ `check` **0（429 文件 / 3247 用例）** ｜
新套件 **5 passed**。

## 7. 仍未完成（如实，**不主张 GUI-02-04 通过**）

- **恢复按钮的界面控件**（让用户在页面上点出来）与"还差什么"的提示 UI **未做** ——
  本轮交付的是**门面方法 + 强制闸门 + HTTP 路由**；
- **真实浏览器人工体验**须由用户提供。
