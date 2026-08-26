import { requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { listAssignableUsers } from "@/lib/queries";
import { today } from "@/lib/recompute";
import {
  baselineFor,
  mixCategories,
  targetableCandidates,
} from "@/lib/services/sales-target-service";
import {
  readingsForPeriod,
  unattributedForPeriod,
} from "@/lib/services/performance-service";
import { TargetsScreen } from "./targets-screen";

export const metadata = { title: "Sales targets — Accounts — MahekOne" };

/**
 * Sales targets, on the Accounts side.
 *
 * The SAME reads and the SAME actions the Sales Dashboard's own targets
 * screen uses — `targetableCandidates`, `mixCategories`, `baselineFor`,
 * `saveSalesTarget`, `publishSalesTarget` — because this is not a second
 * target system, it is the same one reached from a second door. Accounts hold
 * `apps: ["accounts"]` and are redirected out of `/sales` before they reach
 * it, the same way `src/app/crm/layout.tsx` redirects them out of the CRM
 * before they reach a customer — without this page the capability granted in
 * `lib/access-control.ts` would belong to people who had nowhere to use it.
 *
 * `target.set` is checked HERE as well as in every action it guards. The
 * action is the rule — a server action is a URL and a hidden button is not a
 * permission — but a screen that renders and then refuses every save is worse
 * than one that is simply not there.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  await requireCapability("target.set");

  const params = await searchParams;
  const now = await today();
  const period = /^\d{4}-\d{2}$/.test(params.period ?? "")
    ? params.period!
    : now.slice(0, 7);

  const config = await getConfig();
  const [rows, categories, readings, unattributed, everyone] = await Promise.all([
    targetableCandidates(period),
    mixCategories(),
    // Drafts too — this is the desk deciding whether a number is working, not
    // the salesman's own screen, which reads published targets only.
    readingsForPeriod(period, now, { includeDrafts: true }),
    unattributedForPeriod(period),
    listAssignableUsers(),
  ]);

  // Anybody a person here could add by hand, beyond the sales roles
  // `targetableCandidates` shows by default — the same "Add someone" the
  // Sales Dashboard's own screen offers, so a manager or accounts person who
  // has picked up a book is reachable from this door too.
  const shown = new Set(rows.map((r) => r.userId));
  const addable = everyone.filter((u) => !shown.has(u.id));

  const months = config["targets.trailingMonths"];
  const baselines = Object.fromEntries(
    await Promise.all(
      [...rows.map((r) => r.userId), ...addable.map((u) => u.id)].map(
        async (userId) => [userId, await baselineFor(userId, period, months)] as const,
      ),
    ),
  );

  return (
    <TargetsScreen
      period={period}
      rows={rows}
      addable={addable}
      categories={categories}
      baselines={baselines}
      baselineMonths={months}
      revisionReasons={config["performance.revisionReasons"]}
      readings={readings}
      unattributed={unattributed}
    />
  );
}
