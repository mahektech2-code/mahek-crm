import "server-only";
import type { HrmsScreenModule } from "../server";
import { ATTENDANCE_SCREENS } from "./attendance";
import { LEAVE_SCREENS } from "./leave";
import { PAY_SCREENS } from "./pay";
import { TASKS_SCREENS } from "./tasks";
import { PERF_SCREENS } from "./perf";
import { SALES_SCREENS } from "./sales";
import { PEOPLE_SCREENS } from "./people";
import { MISC_SCREENS } from "./misc";

/* ---------------------------------------------------------------------------
 * Every HRMS list screen's server module, by screen key. A registry key with
 * no module here is drawn by its own page (home, settings, org) or not built.
 * ------------------------------------------------------------------------- */

const ALL: HrmsScreenModule[] = [
  ...ATTENDANCE_SCREENS,
  ...LEAVE_SCREENS,
  ...PAY_SCREENS,
  ...TASKS_SCREENS,
  ...PERF_SCREENS,
  ...SALES_SCREENS,
  ...PEOPLE_SCREENS,
  ...MISC_SCREENS,
];

const BY_KEY = new Map(ALL.map((m) => [m.key, m]));

export function hrmsScreenModule(key: string): HrmsScreenModule | undefined {
  return BY_KEY.get(key);
}
