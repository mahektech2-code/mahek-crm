import { today } from "@/lib/recompute";
import { bankPowers, lineDetail, reconcileView, type ReconcileFilter, type ReconcileTab } from "@/lib/services/bank-statement-service";
import { ReconcileScreen } from "./reconcile-screen";

export const metadata = { title: "Reconcile — Bank statement management — Accounts — MahekOne" };

const TABS: ReconcileTab[] = ["todo", "suggested", "unmatched", "flagged", "matched", "ignored", "all"];

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await searchParams;
  const filter: ReconcileFilter = {
    account: p.account || null,
    tab: TABS.includes(p.tab as ReconcileTab) ? (p.tab as ReconcileTab) : "todo",
    q: p.q || null,
    dir: p.dir === "in" || p.dir === "out" ? p.dir : "both",
    period: p.period === "7" || p.period === "30" || p.period === "month" ? p.period : "all",
    upload: p.upload || null,
  };
  const [view, day, powers] = await Promise.all([reconcileView(filter), today(), bankPowers()]);
  /* The panel opens on the line asked for, else — outside Flagged, which is a table of its own — on the first one. */
  const lineId = p.line ?? (filter.tab === "flagged" ? null : (view.rows[0]?.id ?? null));
  const detail = lineId ? await lineDetail(lineId) : null;
  return <ReconcileScreen view={view} filter={filter} detail={detail} today={day} canRecord={powers.record} canConfirm={powers.confirm} />;
}
