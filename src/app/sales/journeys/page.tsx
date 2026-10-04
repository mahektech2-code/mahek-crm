import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { today as businessToday } from "@/lib/recompute";
import { getConfig } from "@/lib/config/store";
import {
  fieldBook,
  fieldTeam,
  journeyPlansBetween,
  journeyPlansFor,
  tracksForDay,
  visitsBetween,
  visitsList,
} from "@/lib/services/sales-service";
import {
  calendarFacts,
  journeyHistory,
  teamJourneySummary,
} from "@/lib/services/journey-service";
import { monthGrid, monthParam } from "@/lib/journey-days";
import { Empty, ScreenHeader } from "@/components/console/parts";
import { JourneysScreen } from "./journeys-screen";
import { SalesmanPicker } from "./salesman-picker";
import { SalesmanTab } from "./salesman-tab";
import { TeamTab, teamWindow } from "./team-tab";
import { TodayTab } from "./today-tab";
import { VisitsTab } from "./visits-tab";

export const metadata = { title: "Journeys & visits — Sales Dashboard — MahekOne" };

/**
 * A month is as far ahead as one proposal reaches.
 *
 * Matched to `MAX_PLAN_DAYS` in the action, which is the authority — this stops
 * somebody typing 400 into the URL and being handed four hundred rows to
 * render before the server refuses them.
 */
const MAX_DAYS = 31;
const DEFAULT_DAYS = 7;

const TABS = [
  { key: "team", label: "Team" },
  { key: "today", label: "Today" },
  { key: "salesman", label: "One salesman" },
  { key: "visits", label: "Visit log" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/**
 * JOURNEYS AND VISITS ARE ONE SCREEN, because they are one story.
 *
 * They were two: Journey planning, which could propose a week of cities and
 * show nothing else, and Visits, a day's log with no idea which of those visits
 * a plan had asked for. A manager wanting to know whether a salesman walked the
 * route he agreed had to hold one screen in his head while reading the other.
 *
 * - **Team** — every salesman: his areas and whether he accepted them, today's
 *   city, the fortnight ahead day by day, who owes whom an answer, and the last
 *   thirty days of shops allocated against shops visited.
 * - **Today** — the whole team's route today.
 * - **One salesman** — a month as a calendar or a list; every day opens into
 *   the negotiation and its history, each allocated shop against the visit that
 *   answered it, the visits off the route, and his punch-in. Proposing a run of
 *   days is its third view.
 * - **Visit log** — what used to be Visits: every visit on a day, verified or
 *   not, with the notes, photographs and voice note.
 *
 * `/sales/visits` forwards here.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    salesman?: string;
    view?: string;
    month?: string;
    open?: string;
    from?: string;
    days?: string;
    day?: string;
    show?: string;
  }>;
}) {
  const params = await searchParams;
  const now = await businessToday();
  const tab: Tab = TABS.some((t) => t.key === params.tab)
    ? (params.tab as Tab)
    : params.salesman
      ? "salesman"
      : "team";
  const keep = params.salesman ? `&salesman=${params.salesman}` : "";

  return (
    <div className="p-6">
      <ScreenHeader
        title="Journeys & visits"
        subtitle="Where each salesman was asked to go, what he said, and what he actually did. You propose a city and he answers; he picks the shops, because he knows whether that market is open on a Wednesday — and every visit is read against the route it belonged to."
      />

      <div className="mb-4 flex items-center border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/sales/journeys?tab=${t.key}${t.key === "salesman" || t.key === "visits" ? keep : ""}`}
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

      {tab === "team" ? (
        <TeamSection now={now} />
      ) : tab === "today" ? (
        <TodaySection now={now} />
      ) : tab === "visits" ? (
        <VisitsSection params={params} now={now} />
      ) : (
        <SalesmanSection params={params} now={now} />
      )}
    </div>
  );
}

async function TeamSection({ now }: { now: string }) {
  const window = teamWindow(now);
  const [team, summary] = await Promise.all([fieldTeam(), teamJourneySummary(window.from, window.to)]);
  return <TeamTab team={team} summary={summary} today={now} />;
}

async function TodaySection({ now }: { now: string }) {
  const [team, plans, visits, tracks] = await Promise.all([
    fieldTeam(),
    journeyPlansFor(now),
    visitsList(now),
    tracksForDay(now),
  ]);
  return <TodayTab team={team} plans={plans} visits={visits} tracks={tracks} today={now} />;
}

async function VisitsSection({
  params,
  now,
}: {
  params: { day?: string; show?: string; salesman?: string };
  now: string;
}) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;
  const show = ["all", "unverified", "offplan"].includes(params.show ?? "") ? params.show! : "all";
  const [all, config, team] = await Promise.all([visitsList(day), getConfig(), fieldTeam()]);
  const salesmanId = team.some((t) => t.id === params.salesman) ? params.salesman! : "";
  return (
    <VisitsTab
      day={day}
      longDay={longDay(day)}
      all={all}
      show={show}
      mismatchThresholdM={config["mbos.location.visitMismatchM"]}
      team={team}
      salesmanId={salesmanId}
    />
  );
}

async function SalesmanSection({
  params,
  now,
}: {
  params: { salesman?: string; view?: string; month?: string; open?: string; from?: string; days?: string; day?: string };
  now: string;
}) {
  const team = await fieldTeam();
  const selected =
    team.find((t) => t.id === params.salesman) ??
    // One salesman is not a choice: land on them rather than on a picker with
    // a single option and an empty screen behind it.
    (team.filter((t) => t.active).length === 1 ? team.find((t) => t.active)! : null);

  const view = params.view === "list" ? "list" : params.view === "propose" ? "propose" : "calendar";

  if (!selected) {
    return (
      <>
        <SalesmanPicker team={team} selectedId="" view={view} />
        <Empty
          title="Whose days are these?"
          body="Choose a salesman above to read his month — every day he was proposed, what he answered, the shops he was allocated and the ones he visited. The Team tab shows everybody at once."
        />
      </>
    );
  }

  if (view === "propose") {
    return <ProposeSection params={params} now={now} team={team} selectedId={selected.id} />;
  }

  const month = monthParam(params.month, now);
  const grid = monthGrid(month);
  const [plans, visits, facts, book] = await Promise.all([
    journeyPlansBetween(grid.from, grid.to, selected.id),
    visitsBetween({ from: grid.from, to: grid.to, salesmanId: selected.id, limit: 3000 }),
    calendarFacts(selected.id, grid.from, grid.to),
    fieldBook({ salesmanId: selected.id }),
  ]);
  const history = await journeyHistory(
    selected.id,
    plans.map((p) => p.id),
    grid.from,
    grid.to,
  );
  const cities = [...new Set(book.map((c) => c.city).filter(Boolean))].sort();
  const openDay = /^\d{4}-\d{2}-\d{2}$/.test(params.open ?? "") ? params.open! : null;

  return (
    <>
      <SalesmanPicker team={team} selectedId={selected.id} view={view} />
      <SalesmanTab
        /* Keyed so a different salesman or month REMOUNTS with fresh state
           rather than resetting itself in an effect. */
        key={`${selected.id}:${month}:${openDay ?? ""}`}
        salesman={selected}
        month={month}
        gridDays={grid.days}
        today={now}
        view={view}
        openDay={openDay}
        plans={plans}
        visits={visits}
        facts={facts}
        history={history}
        cities={cities}
      />
    </>
  );
}

/**
 * Proposing a run of days — a different act from reading a month, so its own
 * view. Tomorrow by default, not today: a route published on the morning it is
 * walked is one the salesman has already worked around. `day` is accepted as
 * well as `from` so older links still land on the right period.
 */
async function ProposeSection({
  params,
  now,
  team,
  selectedId,
}: {
  params: { from?: string; days?: string; day?: string };
  now: string;
  team: Awaited<ReturnType<typeof fieldTeam>>;
  selectedId: string;
}) {
  const asked = params.from ?? params.day;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? "") ? asked! : addDays(now, 1);
  const requested = Number(params.days);
  const horizon =
    Number.isFinite(requested) && requested >= 1 && requested <= MAX_DAYS
      ? Math.floor(requested)
      : DEFAULT_DAYS;
  const to = addDays(from, horizon - 1);
  const selected = team.find((t) => t.id === selectedId)!;

  const [plans, book] = await Promise.all([
    journeyPlansBetween(from, to, selected.id),
    fieldBook({ salesmanId: selected.id }),
  ]);
  /* The cities his own book names. A manager proposes a place, and the places
   * worth proposing are the ones he has customers in. */
  const cities = [...new Set(book.map((c) => c.city).filter(Boolean))].sort();

  return (
    <>
      <SalesmanPicker team={team} selectedId={selected.id} view="propose" />
      <JourneysScreen
        key={`${selected.id}:${from}:${horizon}`}
        selected={selected}
        from={from}
        horizon={horizon}
        plans={plans}
        book={book}
        cities={cities}
      />
    </>
  );
}

function longDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
