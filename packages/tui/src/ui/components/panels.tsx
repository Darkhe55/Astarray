/**
 * TUI 组件（T10）。
 * 职责分离：AppState 是唯一数据源；组件只读状态；输入经回调驱动。
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";

/** 头栏：模式 / 权限组 / mission / agent 数 / 调用与 token 指标。 */
export function Header({
  mode,
  permissionProfile,
  missionCount,
  agentCount,
  metrics,
}: {
  mode: string;
  permissionProfile: string | null;
  missionCount: number;
  agentCount: number;
  metrics: {
    toolCalls: number;
    providerCalls: number;
    estimatedTokenCount: number;
    cacheHits: number;
  };
}): ReactNode {
  return (
    <Text bold>
      {` Astarray ─ mode: ${mode}${permissionProfile !== null ? ` (${permissionProfile})` : ""} ─ missions: ${missionCount} ─ agents: ${agentCount} ─ calls: ${metrics.toolCalls}/${metrics.providerCalls} ─ tokens(est): ${metrics.estimatedTokenCount} ─ cache: ${metrics.cacheHits}`}
    </Text>
  );
}

/** B6R-04b：权限组面板（分页/搜索/当前组标记；不显示内部执行层）。 */
export function PermissionProfilePanel({
  currentDisplayName,
  profiles,
  page,
  pageSize,
  total,
  search,
  focused,
  maximumVisibleRows = 12,
}: {
  currentDisplayName: string | null;
  profiles: Array<{
    permissionProfileId: string;
    displayName: string;
    isBuiltin: boolean;
    revision: number;
  }>;
  page: number;
  pageSize: number;
  total: number;
  search: string;
  focused: boolean;
  maximumVisibleRows?: number;
}): ReactNode {
  const filteredProfiles = search.trim() === ""
    ? profiles
    : profiles.filter(
        (profile) =>
          profile.displayName.toLowerCase().includes(search.trim().toLowerCase()) ||
          profile.permissionProfileId.toLowerCase().includes(search.trim().toLowerCase()),
      );
  const visibleRows = filteredProfiles.slice(0, maximumVisibleRows);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Box flexDirection="column" borderStyle={focused ? "bold" : "round"} paddingX={1}>
      <Text bold>权限组（{total}） 搜索: {search.trim() === "" ? "-" : search} 页 {page}/{pageCount}</Text>
      {visibleRows.length === 0 ? (
        <Text dimColor>（无匹配权限组）</Text>
      ) : (
        visibleRows.map((profile) => {
          const isCurrent =
            currentDisplayName !== null && profile.displayName === currentDisplayName;
          return (
            <Text key={profile.permissionProfileId}>
              {`${isCurrent ? "*" : " "} ${profile.displayName}${profile.isBuiltin ? "（内置）" : ""} rev=${profile.revision}`}
            </Text>
          );
        })
      )}
    </Box>
  );
}

/** 会话与事件面板。 */
export function ConversationPanel({
  entries,
  maximumVisibleEntries = 200,
}: {
  entries: Array<{ entryId: string; source: string; text: string }>;
  maximumVisibleEntries?: number;
}): ReactNode {
  const visibleEntries = entries.slice(-maximumVisibleEntries);
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
      <Text bold>Conversation & Events</Text>
      {visibleEntries.map((entry) => (
        <Text key={entry.entryId} wrap="truncate-end">
          {sourceLabel(entry.source)} {entry.text}
        </Text>
      ))}
    </Box>
  );
}

function sourceLabel(source: string): string {
  switch (source) {
    case "user":
      return "user>";
    case "main":
      return "main>";
    case "tool":
      return "[tool]";
    case "feedback":
      return "[feedback]";
    default:
      return "[event]";
  }
}

/** 任务 DAG 面板：状态标记 + 依赖。 */
export function DagPanel({
  missions,
  focused,
}: {
  missions: Array<{
    missionId: string;
    status: string;
    prompt: string;
    tasks: Array<{
      id: string;
      status: string;
      dependsOn: string[];
    }>;
  }>;
  focused: boolean;
}): ReactNode {
  return (
    <Box
      flexDirection="column"
      width="36%"
      borderStyle="single"
      borderColor={focused ? "cyan" : undefined}
      paddingX={1}
    >
      <Text bold>Tasks / DAG</Text>
      {missions.map((mission) => (
        <Box key={mission.missionId} flexDirection="column">
          <Text bold color="yellow">
            {mission.missionId} ({mission.status})
          </Text>
          <Text wrap="truncate-end">{mission.prompt}</Text>
          {mission.tasks.map((task) => (
            <Text key={task.id}>
              {taskStatusMarker(task.status)} {task.id}
              {task.dependsOn.length > 0 ? ` ← ${task.dependsOn.join(",")}` : ""}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function taskStatusMarker(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "running":
      return "●";
    case "blocked":
      return "⛔";
    case "failed":
      return "✗";
    default:
      return "○";
  }
}

/** Agent 与信箱面板。 */
export function AgentsPanel({
  agentStatuses,
  queueDepths,
}: {
  agentStatuses: Map<string, string>;
  queueDepths: Map<string, number>;
}): ReactNode {
  return (
    <Box flexDirection="column" width="24%" borderStyle="single" paddingX={1}>
      <Text bold>Agents / Mailboxes</Text>
      {[...agentStatuses.entries()].map(([agentId, status]) => (
        <Text key={agentId}>
          {agentId} {status}
          {queueDepths.has(agentId)
            ? ` queue:${queueDepths.get(agentId) ?? 0}`
            : ""}
        </Text>
      ))}
      {agentStatuses.size === 0 ? <Text>（暂无 Agent）</Text> : null}
    </Box>
  );
}

/** 输入框（文本由 App 层 useInput 驱动，这里仅展示）。 */
export function InputBox({
  value,
  placeholder,
  focused,
}: {
  value: string;
  placeholder: string;
  focused: boolean;
}): ReactNode {
  return (
    <Box borderStyle="single" borderColor={focused ? "cyan" : undefined} paddingX={1}>
      <Text bold>Input: </Text>
      <Text color={value.length === 0 ? "gray" : undefined}>
        {value.length === 0 ? placeholder : value}
      </Text>
    </Box>
  );
}

/** 底部快捷键提示。 */
export function StatusLine(): ReactNode {
  return (
    <Text color="gray">
      {" Tab:切换面板  Ctrl+M:模式  Ctrl+N:新任务  Ctrl+C:取消/退出  ?:帮助"}
    </Text>
  );
}

/** 权限询问弹窗。 */
export function PermissionModal({
  ask,
}: {
  ask: {
    toolName: string;
    argumentsJson: string;
    explanation: string;
  };
}): ReactNode {
  return (
    <Box borderStyle="double" borderColor="magenta" paddingX={2} paddingY={1}>
      <Text bold color="magenta">
        权限请求
      </Text>
      <Text wrap="truncate-end">调用: {ask.toolName}({ask.argumentsJson})</Text>
      <Text wrap="truncate-end">说明: {ask.explanation}</Text>
      <Text color="gray">
        [1]允许一次 [2]会话允许 [3]拒绝 [4]修改参数 [Esc]关闭
      </Text>
    </Box>
  );
}

/** 帮助弹窗。 */
export function HelpModal(): ReactNode {
  return (
    <Box borderStyle="single" paddingX={2} paddingY={1}>
      <Text bold>帮助</Text>
      <Text>Tab: 切换面板焦点</Text>
      <Text>Ctrl+M: 切换模式（Ponder / Assist / Devolve）</Text>
      <Text>Ctrl+N: 新建任务</Text>
      <Text>Ctrl+C: 取消当前任务 / 退出</Text>
      <Text>?: 帮助开关</Text>
      <Text>1/2/3/4/Esc: 权限弹窗决策</Text>
    </Box>
  );
}
