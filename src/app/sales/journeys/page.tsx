import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { fieldBook, fieldTeam, journeyPlansBetween } from "@/lib/services/sales-service";
import { JourneysScreen } from "./journeys-screen";

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

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ salesman?: string; from?: string; days?: string; day?: string }>;
}) {
  const params = await searchParams;
  const now = await today();

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
