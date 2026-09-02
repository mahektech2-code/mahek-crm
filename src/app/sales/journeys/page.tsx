import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import {
  fieldBook,
  fieldTeam,
  journeyPlansBetween,
  journeyPlansFor,
  tracksForDay,
  visitsList,
} from "@/lib/services/sales-service";
import { ScreenHeader } from "../parts";
import { JourneysScreen } from "./journeys-screen";
import { TodayTab } from "./today-tab";

export const metadata = { title: "Journey planning — Sales Dashboard — MahekOne" };

/**
 * A month is as far ahead as this plans.
 *
 * Matched to `MAX_PLAN_DAYS` in the action, which is the authority — this stops
 * somebody typing 400 into the URL and being handed four hundred rows to
 * render before the server refuses them.
 */
const MAX_DAYS = 31;
const DEFAULT_DAYS = 7;

const TABS = [
  { key: "plan", label: "Plan" },
  { key: "today", label: "Today" },
] as const;

/**
 * Two tabs, not the design's four.
 *
 * `MBOS Manager Console.dc.html` draws four (Refusals / Plan / Routes /
 * Today), but only ONE of them — Today — is actually wired with data in that
 * file; the other three are markup with nothing behind them. This screen's
 * "Plan" tab already covers proposing days AND answering refusals as one
 * considered flow (see `journeys-screen.tsx`), which is more complete than
 * the design's own unfinished Refusals tab, not less. Building a Routes tab
 * would mean inventing a feature the design never specified rather than
 * matching one — so what is added here is exactly the one tab the design
 * actually specifies and this screen was missing: a same-day, whole-team read
 * of who worked their plan.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    salesman?: string;
    from?: string;
    days?: string;
    day?: string;
  }>;
}) {
  const params = await searchParams;
  const now = await today();
  const tab = params.tab === "today" ? "today" : "plan";

  return (
    <div className="p-6">
      <ScreenHeader
        title="Journey planning"
        subtitle="You propose a city; he answers. Only the salesman picks the customers, because he is the one who knows whether that market is open on a Wednesday — the route is built from what he picks."
      />

      <div className="mb-4 flex items-center border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/sales/journeys?tab=${t.key}`}
            className={
              "-mb-px border-b-2 px-4 py-2.5 text-[14px] no-underline hover:no-underline " +
              (tab === t.key
                ? "border-brand font-medium text-ink"
                : "border-transparent text-muted hover:text-body")
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "today" ? (
        <TodaySection now={now} />
      ) : (
        <PlanTab searchParams={params} now={now} />
      )}
    </div>
  );
}

async function TodaySection({ now }: { now: string }) {
  const [team, plans, visits, tracks] = await Promise.all([
    fieldTeam(),
    journeyPlansFor(now),
    visitsList(now),
    tracksForDay(now),
  ]);
  return <TodayTab team={team} plans={plans} visits={visits} tracks={tracks} />;
}

async function PlanTab({
  searchParams: params,
  now,
}: {
  searchParams: { salesman?: string; from?: string; days?: string; day?: string };
  now: string;
}) {
  /* Tomorrow by default, not today. A route published on the morning it is
   * walked is one the salesman has already worked around. `day` is accepted as
   * well as `from` so the links the Today screen has always carried still land
   * on the right period. */
  const asked = params.from ?? params.day;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? "") ? asked! : addDays(now, 1);

  const requested = Number(params.days);
  const horizon =
    Number.isFinite(requested) && requested >= 1 && requested <= MAX_DAYS
      ? Math.floor(requested)
      : DEFAULT_DAYS;

  const to = addDays(from, horizon - 1);

  const team = await fieldTeam();
  const selected =
    team.find((t) => t.id === params.salesman) ??
    // One salesman is not a choice: land on them rather than on a picker with
    // a single option and an empty screen behind it.
    (team.filter((t) => t.active).length === 1 ? team.find((t) => t.active)! : null);

  const [plans, book, everyonesPlans] = await Promise.all([
    selected ? journeyPlansBetween(from, to, selected.id) : Promise.resolve([]),
    selected ? fieldBook({ salesmanId: selected.id }) : Promise.resolve([]),
    journeyPlansBetween(from, to),
  ]);

  /* The cities his own book names. A manager proposes a place, and the places
   * worth proposing are the ones he has customers in. */
  const cities = [...new Set(book.map((c) => c.city).filter(Boolean))].sort();

  return (
    <JourneysScreen
      /* Keyed so a different salesman or period REMOUNTS with fresh state
       * rather than resetting itself in an effect. Every drawer and modal in
       * this codebase does the same — the React Compiler rules are on. */
      key={`${selected?.id ?? "none"}:${from}:${horizon}`}
      team={team}
      selected={selected ?? null}
      from={from}
      horizon={horizon}
      plans={plans}
      book={book}
      cities={cities}
      everyonesPlans={everyonesPlans}
    />
  );
}
