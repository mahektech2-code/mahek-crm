/* ---------------------------------------------------------------------------
 * THE TASKS APP'S PERMISSIONS — pure, client-safe, no I/O.
 *
 * THE ORG CHART IS THE BASELINE, and every permission here only WIDENS it.
 * Without any of them a person sees, gives and manages tasks for the people
 * below them on the org chart (`teamOf` in service.ts) and their own — which
 * is right for nearly everybody and is what the app shipped with. What the org
 * chart cannot express is the person whose job is the whole company's work: an
 * office manager who chases everybody, a coordinator who hands work out across
 * departments, the person who decides which automatic tasks run. Those used to
 * need platform administrator, which grants every app in the building.
 *
 * So each permission answers ONE question, and the three reaches are kept
 * apart on purpose: reading somebody's tasks, putting work on their list and
 * changing what is already there are three different kinds of trust. Managing
 * implies seeing — a person cannot sensibly be allowed to close a task they are
 * not allowed to read — and nothing else implies anything.
 *
 * A Tasks ADMINISTRATOR (the admin level on the `tasks` grant) and a platform
 * administrator hold every permission without a row, the same rule HRMS and
 * the ERP follow for their powers. They are granted per person on Admin
 * Console → Access, under Tasks, and stored in `task_user_powers`.
 * ------------------------------------------------------------------------- */

export const TASK_POWERS = ["seeAll", "giveAnyone", "manageAnyone", "automations"] as const;
export type TaskPower = (typeof TASK_POWERS)[number];

/** `label` is the checkbox; `source` is the hover — what holding it actually lets somebody do. */
export const TASK_POWER_LABEL: Record<TaskPower, { label: string; source: string }> = {
  seeAll: {
    label: "See everyone's tasks",
    source: "My team lists every person, not only those under them on the org chart, and any task opens read-only. Changing it still needs Manage anyone's tasks.",
  },
  giveAnyone: {
    label: "Give tasks to anyone",
    source: "Give tasks, and set routines, for anybody who holds Tasks or the task's app — not only the people under them.",
  },
  manageAnyone: {
    label: "Manage anyone's tasks",
    source: "Edit, close, reopen, hand over, nudge and delete anybody's tasks, as their manager would. Includes seeing them.",
  },
  automations: {
    label: "Run automatic tasks",
    source: "Switch the automatic tasks each app raises on and off on Set up, and run them now.",
  },
};

export const isTaskPower = (v: string): v is TaskPower => (TASK_POWERS as readonly string[]).includes(v);

/** The known powers out of a list, in the registry's order, each once. */
export function cleanTaskPowers(list: readonly string[]): TaskPower[] {
  return TASK_POWERS.filter((p) => list.includes(p));
}

/**
 * What a person reaches, for each of the three questions.
 *
 * `see`    — whose tasks they may read (the My team screens, opening a task).
 * `give`   — who they may put a task or a routine on.
 * `manage` — whose tasks they may change, as if above that person.
 *
 * `everybody` true means the whole company; false means the org chart below
 * them. Manage implies see.
 */
export type TaskReach = "see" | "give" | "manage";

export function reachesEverybody(powers: ReadonlySet<TaskPower>, reach: TaskReach): boolean {
  if (reach === "see") return powers.has("seeAll") || powers.has("manageAnyone");
  if (reach === "give") return powers.has("giveAnyone");
  return powers.has("manageAnyone");
}

/** Every power, for an administrator. */
export const ALL_TASK_POWERS: ReadonlySet<TaskPower> = new Set(TASK_POWERS);

/**
 * The powers somebody holds: all of them for a Tasks administrator or a
 * platform administrator, otherwise exactly the rows they were granted. A row
 * naming a retired power is ignored rather than trusted.
 */
export function heldTaskPowers(input: { administrator: boolean; rows: readonly string[] }): ReadonlySet<TaskPower> {
  return input.administrator ? ALL_TASK_POWERS : new Set(cleanTaskPowers(input.rows));
}
