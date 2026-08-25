import { requireCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { listAssignableUsers } from "@/lib/queries";
import { today } from "@/lib/recompute";
import {
  baselineFor,
  mixCategories,
  targetableCandidates,
} from "@/lib/services/sales-target-service";
import { TargetsScreen } from "./targets-screen";

export const metadata = { title: "Sales targets — Sales Dashboard — MahekOne" };

/**
 * Where a month is asked for.
 *
 * `target.set` is checked HERE as well as in the action. The action is the
 * rule — a server action is a URL and a hidden button is not a permission —
 * but a manager-only screen that renders for a salesman and then refuses every
 * save is worse than one that is simply not there.
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
  const [rows, categories, everyone] = await Promise.all([
    targetableCandidates(period),
    mixCategories(),
    listAssignableUsers(),
  ]);

  // Anybody a manager could add by hand, beyond the sales roles the list
  // shows by default — the "select who to add" side of the same screen, for
  // whoever the role filter left out: a manager covering a patch themselves,
  // or an accounts person who has picked up a book.
  const shown = new Set(rows.map((r) => r.userId));
  const addable = everyone.filter((u) => !shown.has(u.id));

  /*
   * The trailing average, beside the number about to be typed.
   *
   * §21 of the brief: the decision stays with management, and the system's job
   * is to make sure the growth being asked for is a number somebody chose. A
   * query per person is affordable at this size — this is a company of nine —
   * and the alternative, one aggregate over everybody, cannot answer "what
   * does Rahul do in a month", which is the only question the screen is asking.
   *
   * Read for the addable people too, so picking one from "Add someone" has a
   * baseline to show immediately rather than a second round trip.
   */
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
    />
  );
}
