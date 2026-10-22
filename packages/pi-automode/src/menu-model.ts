export type MenuKey = "up" | "down" | "left" | "right" | "enter";

/** A row whose value changes with the left and right keys. */
export interface ToggleRow {
  kind: "toggle";
  /** The subcommand the row sets, such as `mode`. */
  command: string;
  options: readonly string[];
  initial: number;
  value: number;
}

/** A row that runs one command when the person presses enter on it. */
export interface ActionRow {
  kind: "action";
  label: string;
  args: string;
}

export type MenuRow = ToggleRow | ActionRow;

export function toggleRow(command: string, options: readonly string[], current: string): ToggleRow {
  const found = options.indexOf(current);
  const index = found === -1 ? 0 : found;
  return { kind: "toggle", command, options, initial: index, value: index };
}

function wrap(index: number, delta: number, length: number): number {
  return (index + delta + length) % length;
}

/**
 * The state of the menu, without any drawing. Nothing is applied while the person
 * moves: `press("enter")` returns the commands for the rows that changed.
 */
export class MenuModel {
  readonly rows: MenuRow[];
  cursor = 0;

  constructor(rows: MenuRow[]) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  /** Returns the commands to run when the key finishes the menu, else undefined. */
  press(key: MenuKey): string[] | undefined {
    if (key === "up") this.cursor = wrap(this.cursor, -1, this.rows.length);
    if (key === "down") this.cursor = wrap(this.cursor, 1, this.rows.length);
    if (key === "left") this.#shiftValue(-1);
    if (key === "right") this.#shiftValue(1);
    return key === "enter" ? this.#commands() : undefined;
  }

  #shiftValue(delta: number): void {
    const row = this.rows[this.cursor];
    if (row?.kind !== "toggle") return;
    row.value = wrap(row.value, delta, row.options.length);
  }

  #commands(): string[] {
    const commands: string[] = [];
    for (const row of this.rows) {
      if (row.kind === "toggle" && row.value !== row.initial) commands.push(`${row.command} ${row.options[row.value]}`);
    }
    const current = this.rows[this.cursor];
    // `reload` drops the changes of this session, so it must run before them.
    if (current?.kind === "action") {
      if (current.args === "reload") commands.unshift(current.args);
      else commands.push(current.args);
    }
    // Pressing enter on a toggle row without a change still answers with the status.
    return commands.length > 0 ? commands : ["status"];
  }
}
