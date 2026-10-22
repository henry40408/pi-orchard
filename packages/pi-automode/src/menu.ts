import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Keybinding, type TUI } from "@earendil-works/pi-tui";
import { MenuModel, type MenuKey, type MenuRow } from "./menu-model.ts";

// Up, down, confirm and cancel follow the keybindings of pi, so a remapped key or ctrl+c works as in other menus.
const BOUND_KEYS: ReadonlyArray<[MenuKey, Keybinding]> = [
  ["up", "tui.select.up"],
  ["down", "tui.select.down"],
  ["enter", "tui.select.confirm"],
];

const HINT = "←/→ change  ↑/↓ move  enter apply  esc close";

function renderRow(row: MenuRow, selected: boolean, theme: Theme): string {
  const pointer = selected ? theme.fg("accent", "› ") : "  ";
  if (row.kind === "action") return `${pointer}${selected ? theme.bold(row.label) : row.label}`;
  const options = row.options.map((option, index) => (index === row.value ? theme.fg("accent", theme.bold(option)) : theme.fg("muted", option)));
  const changed = row.value !== row.initial ? theme.fg("warning", " *") : "";
  return `${pointer}${row.command.padEnd(11)}‹ ${options.join(theme.fg("muted", " │ "))} ›${changed}`;
}

export function renderMenu(model: MenuModel, theme: Theme, width: number): string[] {
  const lines = [theme.bold("automode"), ...model.rows.map((row, index) => renderRow(row, index === model.cursor, theme)), "", theme.fg("muted", HINT)];
  return lines.map((line) => truncateToWidth(line, width));
}

/** Shows the menu. Resolves to the commands to run, or undefined when the person pressed escape. */
export function showMenu(ui: ExtensionContext["ui"], rows: MenuRow[]): Promise<string[] | undefined> {
  return ui.custom<string[] | undefined>((tui: TUI, theme, keybindings, done): Component => {
    const model = new MenuModel(rows);
    return {
      render: (width) => renderMenu(model, theme, width),
      invalidate: () => {},
      handleInput(data) {
        if (keybindings.matches(data, "tui.select.cancel")) return done(undefined);
        const bound = BOUND_KEYS.find(([, binding]) => keybindings.matches(data, binding))?.[0];
        const key = bound ?? (matchesKey(data, "left") ? "left" : matchesKey(data, "right") ? "right" : undefined);
        if (!key) return;
        const commands = model.press(key);
        if (commands) return done(commands);
        tui.requestRender();
      },
    };
  });
}
