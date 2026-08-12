/**
 * 面板焦点导航（T10）。
 */
export type PanelFocus = "input" | "dag" | "agents" | "conversation";

export function cyclePanel(current: PanelFocus): PanelFocus {
  switch (current) {
    case "input":
      return "dag";
    case "dag":
      return "agents";
    case "agents":
      return "conversation";
    default:
      return "input";
  }
}
