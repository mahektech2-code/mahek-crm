"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { addDays } from "@/lib/business-date";
import { answerRefusal, proposeJourneyDays, saveJourneyPeriod } from "@/lib/actions/sales";
import type { BookCustomer, JourneyPlan, Salesman } from "@/lib/services/sales-service";
import { SalesIcon } from "../icons";
import { Banner, Button, Empty, Pill } from "../parts";
import { plural } from "../words";

/**
 * Where somebody works, agreed rather than issued.
 *
 * From `MBOS Manager Console.dc.html`: *"A day in a plan moves proposed →
 * refused → agreed → planned. Only the salesman picks the customers, because
 * he knows the city; the route is built from that."*
 *
 * That is a real reversal of who decides what, and it is right. The manager
 * proposes a CITY — a thing an office can sensibly decide — and the salesman
 * answers, because he is the one who knows that Tumakuru market shuts on a
 * Wednesday, or that Surat and Rajkot back to back is 340 km in a day. Both of
 * those are refusals from the design's own fixture and neither is something
 * this screen could have worked out.
 *
 * So there are two halves here. Proposing a run of days, which is the
 * manager's; and answering what came back, which is the conversation. A
 * refused day can be re-proposed or his own suggestion taken — and there is
 * deliberately no button that overrules him into a planned day, because the
 * whole reason for asking was that his answer is worth more.
 *
 * The old behaviour — the manager picking shops directly — is kept as
 * "Pick the shops yourself", for the days somebody genuinely does need to
 * arrange from the office. It is the exception now rather than the model.
 */

const HORIZONS = [7, 15, 30] as const;

type DayRow = {
  date: string;
  plan: JourneyPlan | null;
  /** What the manager is proposing for this day, before saving. */
  city: string;
};

export function JourneysScreen({
  team,
  selected,
  from,
  horizon,
  plans,
  book,
  cities,
  everyonesPlans,
}: {
  team: Salesman[];
  selected: Salesman | null;
  from: string;
  horizon: number;
  plans: JourneyPlan[];
  book: BookCustomer[];
  /** The cities this salesman's own book actually names. */
  cities: string[];
  everyonesPlans: JourneyPlan[];
}) {
  const router = useRouter();
  const toast = useToast();

  const dates = React.useMemo(() => runOfDays(from, horizon), [from, horizon]);

  /*
   * WHAT IS STATE HERE IS THE TYPING, AND NOTHING ELSE.
   *
   * The whole grid used to be seeded from `plans` in a `useState` initialiser.
   * The parent keys this on the salesman and the period, so changing either
   * remounts it — but SAVING changes neither. Every write here ends in
   * `router.refresh()`, which hands down fresh plans to a component that had
   * already made up its mind, so the proposed days went on rendering as empty
   * boxes, the refused banner went on showing an answered refusal, and the
   * button stayed enabled against a plan that had already been written. It
   * read exactly like a save that had been thrown away, and pressing it again
   * proposed the same days a second time.
   *
   * So the rows are DERIVED from props on every render and only the cities
   * somebody has typed are held. A draft is dropped once it has been saved,
   * and what is left is whatever the server just said.
   */
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const days: DayRow[] = React.useMemo(
    () =>
      dates.map((date) => {
        const plan = plans.find((p) => p.planDate === date) ?? null;
        return { date, plan, city: drafts[date] ?? plan?.city ?? "" };
      }),
    [dates, plans, drafts],
  );

  const refused = days.filter((d) => d.plan?.dayState === "refused");
  const proposed = days.filter((d) => d.plan?.dayState === "proposed");
  const agreed = days.filter((d) => d.plan?.dayState === "agreed");
  const planned = days.filter((d) => d.plan?.dayState === "planned");

  const dirty = days.filter(
    (d) => d.city.trim() && d.city.trim() !== (d.plan?.city ?? ""),
  );

  function setCity(date: string, city: string) {
    setDrafts((d) => ({ ...d, [date]: city }));
  }

  /** The first seven days' cities, copied across the rest. */
  function repeatFirstWeek() {
    const week = days.slice(0, 7);
    if (!week.length) return;
    setDrafts((current) => {
      const next = { ...current };
      days.forEach((d, i) => {
        if (i < 7) return;
        if (d.plan?.dayState === "planned" || d.plan?.dayState === "agreed") return;
        next[d.date] = week[i % 7].city;
      });
      return next;
    });
  }

  async function propose() {
    if (!selected) return;
    const sending = dirty.map((d) => ({
      planDate: d.date,
      city: d.city.trim(),
    }));
    setBusy(true);
    setError(null);
    try {
      const result = await proposeJourneyDays({
        salesmanId: selected.id,
        days: sending,
      });
      if (!result.ok) return setError(result.error);
      /* The days that were sent stop being drafts, so what the grid draws from
       * here is what the server holds. Dropping only the ones that went keeps
       * anything typed while the save was in flight. */
      setDrafts((current) => {
        const next = { ...current };
        for (const d of sending) delete next[d.planDate];
        return next;
      });
      toast.push(result.message ?? "Proposed.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function answer(
    date: string,
    planId: string,
    take: "counter" | "other",
    city?: string,
  ) {
    setBusy(true);
    setError(null);
    try {
      const result = await answerRefusal({ planId, take, city });
      if (!result.ok) return setError(result.error);
      /* Taking HIS city writes a different one than the box is showing, and a
       * draft left behind would shadow the answer that was just agreed. */
      setDrafts((current) => {
        if (!(date in current)) return current;
        const next = { ...current };
        delete next[date];
        return next;
      });
      toast.push(result.message ?? "Answered.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  /** The exception: arranging a day from the office, shops and all. */
  async function pickFromOffice(date: string, customerIds: string[]) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveJourneyPeriod({
        salesmanId: selected.id,
        days: [{ planDate: date, customerIds }],
      });
      if (!result.ok) return setError(result.error);
      toast.push(result.message ?? "Saved.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const unplanned = team.filter(
    (t) =>
      t.active && t.id !== selected?.id && !everyonesPlans.some((p) => p.userId === t.id),
  );

  return (
    <>
      {/* ------------------------------------------------------- the controls */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Salesman
          </span>
          <select
            value={selected?.id ?? ""}
            onChange={(e) => go(router, e.target.value, from, horizon)}
            className="h-8.5 min-w-[190px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          >
            <option value="">Choose somebody</option>
            {team.map((t) => (
              <option key={t.id} value={t.id} disabled={!t.active}>
                {t.name}
                {t.active ? "" : " (account closed)"}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            From
          </span>
          <input
            type="date"
            value={from}
            onChange={(e) => go(router, selected?.id ?? "", e.target.value, horizon)}
            className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>

        <div className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            For
          </span>
          <div className="flex items-center gap-1">
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => go(router, selected?.id ?? "", from, h)}
                className={
                  "h-8.5 cursor-pointer rounded-[4px] border px-2.5 text-sm font-medium " +
                  (horizon === h
                    ? "border-brand bg-brand-soft text-[#5223E0]"
                    : "border-line bg-surface text-body hover:bg-canvas")
                }
              >
                {h} days
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={31}
              value={HORIZONS.includes(horizon as never) ? "" : horizon}
              placeholder="Custom"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 1 && n <= 31) go(router, selected?.id ?? "", from, n);
              }}
              title="Any run of days up to 31. Beyond a month a route is a forecast — the book moves under it."
              className="h-8.5 w-[92px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
            />
          </div>
        </div>

        <div className="flex-1" />

        {selected ? (
          <>
            <Button disabled={busy || horizon <= 7} onClick={repeatFirstWeek}>
              Repeat week 1
            </Button>
            <Button
              tone="primary"
              disabled={busy || dirty.length === 0}
              title={dirty.length === 0 ? "Nothing has been changed." : undefined}
              onClick={() => void propose()}
            >
              {busy ? "Sending…" : `Propose ${plural(dirty.length, "day")}`}
            </Button>
          </>
        ) : null}
      </div>

      {error ? <Banner tone="danger" title="That did not save" body={error} /> : null}

      {refused.length ? (
        <Banner
          tone="warn"
          title={`${plural(refused.length, "day")} came back refused`}
          body="He has said why, and sometimes where he would rather go. Take his suggestion or put a different city back to him — there is no way to overrule it, because the reason for asking was that his answer is worth more than a guess from here."
        />
      ) : null}

      {unplanned.length ? (
        <Banner
          tone="warn"
          title={`${plural(unplanned.length, "salesman", "salesmen")} ${unplanned.length === 1 ? "has" : "have"} nothing in this period`}
          body={unplanned.map((u) => u.name).join(", ")}
        />
      ) : null}

      {!selected ? (
        <Empty
          title="Whose days are these?"
          body="Choose a salesman above. You propose the city and he answers — which is why the list you pick from is places rather than shops."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3.5 rounded-[6px] border border-line bg-surface px-5 py-3.5">
            {[
              {
                label: "Proposed",
                value: proposed.length,
                sub: "waiting on him",
              },
              {
                label: "Refused",
                value: refused.length,
                sub: "waiting on you",
                tone: "warn",
              },
              {
                label: "Agreed",
                value: agreed.length,
                sub: "he picks the shops",
              },
              { label: "Planned", value: planned.length, sub: "shops picked" },
            ].map((m) => (
              <span key={m.label} className="block">
                <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  {m.label}
                </span>
                <span
                  className={
                    "block text-[22px] leading-7 font-semibold tabular-nums " +
                    (m.tone === "warn" && m.value ? "text-warn-ink" : "text-ink")
                  }
                >
                  {m.value}
                </span>
                <span className="block text-xs text-muted">{m.sub}</span>
              </span>
            ))}
          </div>

          <section className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <header className="flex h-10 items-center justify-between border-b border-line px-4">
              <span className="text-[13px] font-semibold text-ink">
                {longDay(dates[0])} to {longDay(dates[dates.length - 1])}
              </span>
              <span className="text-[12px] text-muted">
                {book.length
                  ? `${cities.length} cities in his book`
                  : "his book is empty"}
              </span>
            </header>

            <div className="divide-y divide-divider">
              {days.map((d) => (
                <DayLine
                  key={d.date}
                  row={d}
                  cities={cities}
                  book={book}
                  busy={busy}
                  onCity={(c) => setCity(d.date, c)}
                  onAnswer={(take, city) =>
                    d.plan && void answer(d.date, d.plan.id, take, city)
                  }
                  onPickFromOffice={(ids) => void pickFromOffice(d.date, ids)}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}

/* --------------------------------------------------------------- one day */

function DayLine({
  row,
  cities,
  book,
  busy,
  onCity,
  onAnswer,
  onPickFromOffice,
}: {
  row: DayRow;
  cities: string[];
  book: BookCustomer[];
  busy: boolean;
  onCity: (city: string) => void;
  onAnswer: (take: "counter" | "other", city?: string) => void;
  onPickFromOffice: (customerIds: string[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<string[]>([]);
  const state = row.plan?.dayState;
  const weekend = isSunday(row.date);

  const tone =
    state === "refused"
      ? "warn"
      : state === "planned"
        ? "success"
        : state === "agreed"
          ? "brand"
          : "neutral";

  return (
    <div className={"px-4 py-2.5 " + (weekend ? "bg-canvas" : "")}>
      <div className="flex items-center gap-3">
        <span className="w-[120px] flex-none">
          <span className="block text-sm font-medium text-ink">{shortDay(row.date)}</span>
          <span className="block text-[11px] text-muted">
            {weekday(row.date)}
            {weekend ? " · usually off" : ""}
          </span>
        </span>

        {state === "planned" ? (
          <span className="min-w-0 flex-1 text-[13px] text-body">
            {row.plan?.city ?? row.plan?.beat ?? "Arranged"} ·{" "}
            {plural(row.plan?.stops.length ?? 0, "stop")}
          </span>
        ) : (
          <>
            <input
              list="sales-cities"
              value={row.city}
              onChange={(e) => onCity(e.target.value)}
              disabled={busy || state === "agreed"}
              placeholder="Propose a city"
              title={
                state === "agreed"
                  ? "He has agreed this day. He picks the shops next."
                  : "The unit you propose. He divides it into a beat himself."
              }
              className="h-8 w-[220px] flex-none rounded-[4px] border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-brand disabled:opacity-60"
            />
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
              {state === "refused" && row.plan?.refusalReason ? (
                <>
                  <span className="text-warn-ink">“{row.plan.refusalReason}”</span>
                  {row.plan.counterCity ? (
                    <span className="text-body"> — he wants {row.plan.counterCity}</span>
                  ) : null}
                </>
              ) : state === "proposed" ? (
                "Waiting on his answer"
              ) : state === "agreed" ? (
                "Agreed — he picks the shops"
              ) : (
                "Nothing proposed"
              )}
            </span>
          </>
        )}

        {state ? <Pill tone={tone as never}>{state}</Pill> : null}

        {state === "refused" ? (
          <span className="flex flex-none gap-1.5">
            {row.plan?.counterCity ? (
              <Button
                size="sm"
                tone="primary"
                disabled={busy}
                onClick={() => onAnswer("counter")}
              >
                Take {row.plan.counterCity}
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={busy || !row.city.trim() || row.city.trim() === row.plan?.city}
              title={
                !row.city.trim()
                  ? "Type a different city above to put it back to him."
                  : undefined
              }
              onClick={() => onAnswer("other", row.city.trim())}
            >
              Propose instead
            </Button>
          </span>
        ) : null}

        {state !== "planned" ? (
          <Button
            size="sm"
            tone="quiet"
            disabled={busy}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Close" : "Pick the shops yourself"}
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-2 ml-[132px] border-l border-divider pl-3">
          <p className="mb-2 max-w-[620px] text-[12px] text-pretty text-muted">
            The exception rather than the model. Arranging a day from here skips the
            conversation — worth it when somebody genuinely has to be sent somewhere, and
            worth avoiding otherwise, because he knows the city and you do not.
          </p>
          <div className="flex max-h-[240px] flex-wrap gap-1.5 overflow-y-auto">
            {book.length === 0 ? (
              <span className="text-[13px] text-muted">His book is empty.</span>
            ) : (
              book.map((c) => {
                const on = picked.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() =>
                      setPicked(on ? picked.filter((x) => x !== c.id) : [...picked, c.id])
                    }
                    className={
                      "inline-flex h-7 items-center gap-1.5 rounded-[4px] border px-2 text-[12px] " +
                      (on
                        ? "border-brand bg-brand-soft text-[#5223E0]"
                        : "border-line bg-surface text-body hover:bg-canvas")
                    }
                  >
                    {on ? <SalesIcon name="tick" size={12} /> : null}
                    {c.name}
                    {!c.hasGps ? <span className="text-warn-ink">no pin</span> : null}
                  </button>
                );
              })
            )}
          </div>
          {picked.length ? (
            <div className="mt-2">
              <Button
                size="sm"
                tone="primary"
                disabled={busy}
                onClick={() => onPickFromOffice(picked)}
              >
                Arrange {plural(picked.length, "stop")} from the office
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <datalist id="sales-cities">
        {cities.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function go(
  router: ReturnType<typeof useRouter>,
  salesman: string,
  from: string,
  horizon: number,
) {
  router.push(`/sales/journeys?salesman=${salesman}&from=${from}&days=${horizon}`);
}

function runOfDays(from: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(addDays(from, i));
  return out;
}

/* Calendar days, built in UTC: there is no time of day in them to get wrong,
   and building them locally is what shifts a date across a DST boundary. */
function parts(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const weekday = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    parts(iso),
  );

const shortDay = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(parts(iso));

const longDay = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(parts(iso));

const isSunday = (iso: string) => parts(iso).getUTCDay() === 0;
