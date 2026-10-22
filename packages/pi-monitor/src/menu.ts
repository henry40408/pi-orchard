import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Keybinding, type TUI } from "@earendil-works/pi-tui";
import { formatDuration } from "./command.ts";
import type { MonitorTask } from "./registry.ts";
import { MenuModel, type MenuKey, type MenuRow } from "./menu-model.ts";

// Up, down, confirm and cancel follow the keybindings of pi, so a remapped key or ctrl+c works as in other menus.
const BOUND_KEYS: ReadonlyArray<[MenuKey, Keybinding]> = [
  ["up", "tui.select.up"],
  ["down", "tui.select.down"],
  ["enter", "tui.select.confirm"],
  ["escape", "tui.select.cancel"],
];

const MAX_DETAIL_LINES = 12;
const HINT = "↑/↓ move  enter details  x cancel  X cancel all  esc close";

function renderRow(row: MenuRow, selected: boolean, theme: Theme, now: number): string {
  const pointer = selected ? theme.fg("accent", "› ") : "  ";
  if (row.kind === "action") return `${pointer}${selected ? theme.bold(row.label) : row.label}`;
  const { task } = row;
  const id = selected ? theme.bold(task.id) : task.id;
  return `${pointer}${id}  ${theme.fg("muted", formatDuration(now - task.startedAt))}  ${task.description}`;
}

function detailLines(task: MonitorTask, theme: Theme, now: number): string[] {
  const status = task.status === "running" ? "running for" : `${task.status} after`;
  const text = task.command.split("\n");
  const shown = text.length > MAX_DETAIL_LINES ? [...text.slice(0, MAX_DETAIL_LINES), "…"] : text;
  const time = formatDuration((task.finishedAt ?? now) - task.startedAt);
  return [theme.bold(task.id), theme.fg("muted", `${status} ${time}`), ...shown, theme.fg("muted", "any key: back")];
}

function bottomLines(model: MenuModel, theme: Theme, now: number): string[] {
  const { mode } = model;
  if (mode.kind === "confirm") {
    const what = mode.target === "all" ? `all ${model.runningCount} running monitors` : mode.target;
    return [theme.fg("warning", `Cancel ${what}? y/N`)];
  }
  const detailed = mode.kind === "detail" ? model.find(mode.id) : undefined;
  if (detailed) return detailLines(detailed, theme, now);
  return [theme.fg("muted", HINT)];
}

export function renderMenu(model: MenuModel, theme: Theme, width: number, now: number): string[] {
  const empty = model.runningCount === 0 ? [theme.fg("muted", "  no monitor is running")] : [];
  const rows = model.rows.map((row, index) => renderRow(row, index === model.cursor, theme, now));
  const lines = [theme.bold("monitor"), ...empty, ...rows, "", ...bottomLines(model, theme, now)];
  return lines.map((line) => truncateToWidth(line, width));
}

function keyOf(data: string, keybindings: { matches(data: string, binding: Keybinding): boolean }): MenuKey {
  const bound = BOUND_KEYS.find(([, binding]) => keybindings.matches(data, binding))?.[0];
  if (bound) return bound;
  if (data === "x") return "cancel";
  if (data === "X") return "cancelAll";
  if (data === "y" || data === "Y") return "yes";
  return matchesKey(data, "escape") ? "escape" : "other";
}

/** Shows the menu. Resolves to the commands to run; an empty list means the person closed it. */
export function showMenu(ui: ExtensionContext["ui"], listTasks: () => MonitorTask[], now: () => number = Date.now): Promise<string[]> {
  return ui.custom<string[]>((tui: TUI, theme, keybindings, done): Component => {
    const model = new MenuModel(listTasks);
    return {
      render: (width) => renderMenu(model, theme, width, now()),
      invalidate: () => {},
      handleInput(data) {
        const commands = model.press(keyOf(data, keybindings));
        if (commands) return done(commands);
        tui.requestRender();
      },
    };
  });
}
