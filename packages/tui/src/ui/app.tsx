/**
 * TUI 根组件（T10）。
 * 读 AppState 渲染四面板 + 输入框 + 弹窗；键盘驱动模式切换/帮助/权限决策。
 */
import { useEffect, useReducer, useState } from "react";
import { Box, useInput } from "ink";
import type { ReactNode } from "react";

import type { AgentMode } from "../../../core/src/core/types.js";
import type { AppState } from "./state/app-state.js";
import type { MainController } from "../../../core/src/orchestration/main-controller.js";
import { cyclePanel } from "./panel-navigation.js";
import type { PanelFocus } from "./panel-navigation.js";
import {
  AgentsPanel,
  ConversationPanel,
  DagPanel,
  Header,
  HelpModal,
  InputBox,
  PermissionModal,
  PermissionProfilePanel,
  StatusLine,
} from "./components/panels.js";

export interface AstarrayAppProps {
  state: AppState;
  controller: MainController;
  onRequestExit: () => void;
}

export function AstarrayApp(props: AstarrayAppProps): ReactNode {
  const { state, controller, onRequestExit } = props;
  const [focusedPanel, setFocusedPanel] = useState<PanelFocus>("input");
  const [, forceRender] = useReducer((count: number) => count + 1, 0);

  useInput((input, key) => {
    if (state.permissionAsk !== null) {
      handlePermissionKey(input, key, state, controller);
      return;
    }
    if (key.tab) {
      setFocusedPanel(cyclePanel(focusedPanel));
      return;
    }
    if (input === "?") {
      state.toggleHelp();
      return;
    }
    if (state.showHelp) {
      return;
    }
    if (key.ctrl && input === "m") {
      cycleMode(state, controller);
      return;
    }
    if (focusedPanel === "input") {
      if (key.return) {
        submitPrompt(state, controller, state.inputText);
        return;
      }
      if (key.backspace) {
        state.setInputText(state.inputText.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        state.setInputText(state.inputText + input);
      }
      return;
    }
    if (key.ctrl && input === "c") {
      if (state.missions.size > 0) {
        const latestMissionId = [...state.missions.keys()].at(-1);
        if (latestMissionId !== undefined) {
          void controller.cancelMission(latestMissionId).then(() => {
            state.pushConversation("system", `已取消任务 ${latestMissionId}`);
            void refreshMissions(state, controller);
          });
        }
      } else {
        onRequestExit();
      }
      return;
    }
  });

  useEffect(() => {
    return state.subscribe(() => {
      forceRender();
    });
  }, [state]);

  useEffect(() => {
    void refreshMissions(state, controller);
    void refreshMetrics(state, controller);
    void refreshPermissionProfiles(state, controller);
    const pollTimer = setInterval(() => {
      void refreshMissions(state, controller);
      void refreshMetrics(state, controller);
      void refreshPermissionProfiles(state, controller);
    }, 500);
    return () => clearInterval(pollTimer);
  }, [state, controller]);

  const visibleMissions = [...state.missions.values()];
  const terminalWidth = process.stdout.columns ?? 80;

  return (
    <Box flexDirection="column">
      <Header
        mode={state.mode}
        permissionProfile={state.currentPermissionProfileDisplayName}
        missionCount={state.missions.size}
        agentCount={state.agentStatuses.size}
        metrics={{
          toolCalls: state.metrics.toolCalls,
          providerCalls: state.metrics.providerCalls,
          estimatedTokenCount: state.metrics.estimatedTokenCount,
          cacheHits: state.metrics.cacheHits,
        }}
      />
      <Box flexDirection="row" flexGrow={1}>
        <DagPanel
          missions={visibleMissions.map((mission) => ({
            missionId: mission.missionId,
            status: mission.status,
            prompt: mission.prompt,
            tasks: mission.tasks,
          }))}
          focused={focusedPanel === "dag"}
        />
        <ConversationPanel entries={state.conversation} />
        <AgentsPanel
          agentStatuses={state.agentStatuses}
          queueDepths={state.mailboxQueueDepths}
        />
      </Box>
      {/* B6R-04b：权限组面板（独立行；小终端自动折叠次要面板） */}
      {terminalWidth >= 100 ? (
        <PermissionProfilePanel
          currentDisplayName={state.currentPermissionProfileDisplayName}
          profiles={state.permissionProfiles}
          page={state.permissionProfilePage}
          pageSize={state.permissionProfilePageSize}
          total={state.permissionProfileTotal}
          search={state.permissionProfileSearch}
          focused={false}
        />
      ) : null}
      <InputBox
        value={state.inputText}
        placeholder="输入任务（Enter 提交）"
        focused={focusedPanel === "input"}
      />
      <StatusLine />
      {state.permissionAsk !== null ? (
        <PermissionModal ask={state.permissionAsk} />
      ) : null}
      {state.showHelp ? <HelpModal /> : null}
    </Box>
  );
}

function submitPrompt(state: AppState, controller: MainController, text: string): void {
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return;
  }
  state.pushConversation("user", trimmedText);
  state.setInputText("");
  void controller.handleUserMessage(trimmedText).then((missionId) => {
    if (missionId !== "ponder") {
      state.pushConversation("system", `任务已受理: ${missionId}`);
      void refreshMissions(state, controller);
    }
  });
}

function handlePermissionKey(
  input: string,
  key: { escape?: boolean },
  state: AppState,
  controller: MainController,
): void {
  if (key.escape) {
    state.closePermissionAsk();
    return;
  }
  switch (input) {
    case "1":
      decidePermission("allow-once", state, controller);
      break;
    case "2":
      decidePermission("allow-session", state, controller);
      break;
    case "3":
      decidePermission("deny", state, controller);
      break;
    case "4":
      decidePermission("modify", state, controller);
      break;
    default:
      break;
  }
}

function decidePermission(
  decision: "allow-once" | "allow-session" | "deny" | "modify",
  state: AppState,
  controller: MainController,
): void {
  const ask = state.permissionAsk;
  if (ask === null) {
    return;
  }
  state.closePermissionAsk();
  if (decision === "deny") {
    state.pushConversation("system", `已拒绝权限调用 ${ask.toolName}`);
    return;
  }
  const nowUnixSeconds = Math.floor(Date.now() / 1000);
  void controller.grantSessionAuthorization(ask.toolName, ask.argumentsJson, nowUnixSeconds);
  controller.sendSchedulerInstruction(
    ask.missionId,
    JSON.stringify({ action: "unblock", taskId: ask.taskId }),
  );
  state.pushConversation(
    "system",
    decision === "modify"
      ? `已修改参数并授权调用 ${ask.toolName}`
      : `已授权调用 ${ask.toolName}`,
  );
}

function cycleMode(state: AppState, controller: MainController): void {
  const nextMode: AgentMode =
    state.mode === "ponder" ? "assist" : state.mode === "assist" ? "devolve" : "ponder";
  controller.transitionMode(nextMode);
  state.setMode(nextMode);
  state.pushConversation("system", `模式切换为 ${modeName(nextMode)}`);
}

function modeName(mode: AgentMode): string {
  switch (mode) {
    case "ponder":
      return "Ponder（思索）";
    case "assist":
      return "Assist（协同）";
    case "devolve":
      return "Devolve（放权）";
  }
}

async function refreshMissions(state: AppState, controller: MainController): Promise<void> {  for (const missionId of controller.getActiveMissionIds()) {
    try {
      const missionStatus = await controller.queryMissionStatus(missionId);
      if (missionStatus.summary === null) {
        continue;
      }
      state.upsertMission({
        missionId,
        mode: missionStatus.summary.mode,
        status: missionStatus.summary.status,
        prompt: missionStatus.summary.prompt,
        tasks: missionStatus.taskChain?.tasks ?? [],
      });
      for (const task of missionStatus.taskChain?.tasks ?? []) {
        if (task.assignedAgentId !== null) {
          const agentStatus =
            task.status === "running"
              ? "busy"
              : task.status === "blocked"
                ? "blocked"
                : "idle";
          state.setAgentStatus(task.assignedAgentId, agentStatus);
        }
      }
    } catch {
      // mission 可能已被清理
    }
  }
}

async function refreshMetrics(state: AppState, controller: MainController): Promise<void> {
  const metrics = controller.getMetricsSnapshot();
  if (metrics !== null) {
    state.setMetrics({
      toolCalls: metrics.toolCalls,
      providerCalls: metrics.providerCalls,
      estimatedTokenCount: metrics.estimatedTokenCount,
      cacheHits: metrics.cacheHits,
      cacheMisses: metrics.cacheMisses,
    });
  }
}

/** B6R-04b：只读刷新权限组列表与当前组显示名（不打断输入）。 */
async function refreshPermissionProfiles(
  state: AppState,
  controller: MainController,
): Promise<void> {
  try {
    const [currentReference, profileList] = await Promise.all([
      controller.getCurrentPermissionProfileReference(),
      controller.listPermissionProfiles({
        page: state.permissionProfilePage,
        pageSize: state.permissionProfilePageSize,
      }),
    ]);
    let currentDisplayName: string | null = null;
    if (currentReference !== null) {
      const currentProfile = profileList.profiles.find((profile) => {
        if (currentReference.kind === "builtin") {
          return profile.isBuiltin && profile.permissionProfileId === currentReference.profileId;
        }
        return (
          !profile.isBuiltin && profile.permissionProfileId === currentReference.profileId
        );
      });
      currentDisplayName = currentProfile?.displayName ?? null;
    }
    state.setPermissionProfiles({
      currentDisplayName,
      profiles: profileList.profiles,
      page: profileList.page,
      pageSize: profileList.pageSize,
      total: profileList.total,
    });
  } catch {
    // 设置控制面未装配：忽略（TUI 继续工作）
  }
}
