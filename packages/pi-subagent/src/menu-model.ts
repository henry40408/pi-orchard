import type { BackgroundTask } from "./background.ts";

export type MenuKey = "up" | "down" | "enter" | "escape" | "cancel" | "cancelAll" | "yes" | "other";

/** A running background subagent. */
export interface TaskRow {
  kind: "task";
  task: BackgroundTask;
}

/** A row that runs one command when the person presses enter on it. */
export interface ActionRow {
  kind: "action";
  label: string;
  args: string;
}

export type MenuRow = TaskRow | ActionRow;

/** The ids are kept, not the tasks: a task may end while the menu is open. */
export type MenuMode = { kind: "browse" } | { kind: "detail"; id: string } | { kind: "confirm"; target: "all" | string };

export const ACTION_ROWS: readonly ActionRow[] = [
  { kind: "action", label: "status", args: "status" },
  { kind: "action", label: "history", args: "history" },
];

function wrap(index: number, delta: number, length: number): number {
  return (index + delta + length) % length;
}

/**
 * The state of the menu, without any drawing. A cancel needs a second key:
 * only `yes` confirms, and every other key goes back to the list.
 * The tasks are read again for each key and each drawing, so the list follows the registry.
 */
export class MenuModel {
  cursor = 0;
  mode: MenuMode = { kind: "browse" };
  #listTasks: () => BackgroundTask[];

  constructor(listTasks: () => BackgroundTask[]) {
    this.#listTasks = listTasks;
  }

  get rows(): MenuRow[] {
    const running = this.#listTasks().filter((task) => task.status === "running");
    return [...running.map((task): TaskRow => ({ kind: "task", task })), ...ACTION_ROWS];
  }

  get runningCount(): number {
    return this.rows.filter((row) => row.kind === "task").length;
  }

  /** The task now, whatever its status; undefined when the registry dropped it. */
  find(id: string): BackgroundTask | undefined {
    return this.#listTasks().find((task) => task.id === id);
  }

  /** Returns the commands to run when the key finishes the menu (empty: just close), else undefined. */
  press(key: MenuKey): string[] | undefined {
    this.cursor = Math.min(this.cursor, this.rows.length - 1);
    if (this.mode.kind === "confirm") return this.#answerConfirmation(this.mode.target, key);
    if (this.mode.kind === "detail") {
      this.mode = { kind: "browse" };
      return undefined;
    }
    return this.#browse(key);
  }

  #answerConfirmation(target: "all" | string, key: MenuKey): string[] | undefined {
    this.mode = { kind: "browse" };
    if (key !== "yes") return undefined;
    // A task that ended while the question was open needs no cancel.
    if (target !== "all" && this.find(target)?.status !== "running") return undefined;
    return [target === "all" ? "cancel all" : `cancel ${target}`];
  }

  #browse(key: MenuKey): string[] | undefined {
    const rows = this.rows;
    if (key === "escape") return [];
    if (key === "up") this.cursor = wrap(this.cursor, -1, rows.length);
    if (key === "down") this.cursor = wrap(this.cursor, 1, rows.length);
    if (key === "cancelAll" && this.runningCount > 0) this.mode = { kind: "confirm", target: "all" };
    const current = rows[this.cursor];
    if (key === "cancel" && current?.kind === "task") this.mode = { kind: "confirm", target: current.task.id };
    if (key === "enter" && current?.kind === "task") this.mode = { kind: "detail", id: current.task.id };
    if (key === "enter" && current?.kind === "action") return [current.args];
    return undefined;
  }
}
