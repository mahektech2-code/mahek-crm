"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { ComboBox } from "@/components/ui/combo-box";
import { splitBook } from "@/lib/city-match";
import { addDays } from "@/lib/business-date";
import { answerRefusal, proposeJourneyDays, saveJourneyPeriod } from "@/lib/actions/sales";
import type { BookCustomer, JourneyPlan, Salesman } from "@/lib/services/sales-service";
import { HEALTH_BAND_LABELS } from "@/lib/engines/inactivity";

/* The words are the shared ones — the same map the owner's report and the
   handset read, so three surfaces cannot come to call one shop three things. */
const BAND_TITLE: Record<string, string> = {
  active: `${HEALTH_BAND_LABELS.active} — ordering on their own rhythm`,
  "at-risk": `${HEALTH_BAND_LABELS["at-risk"]} — past their own cycle`,
  dormant: `${HEALTH_BAND_LABELS.dormant} — well past it`,
  lost: `${HEALTH_BAND_LABELS.lost} — no order for a long time`,
};
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

/**
 * One shop in the picker.
 *
 * Pulled out of the panel because it is now drawn from three lists — the
 * city's own shops, the ones nothing can place, and the manager's deliberate
 * pick from somewhere else — and three copies of a chip is three places for
 * the health dot or the "no pin" mark to go missing from.
 */
function ShopChip({
  c,
  on,
  onToggle,
  showCity,
}: {
  c: BookCustomer;
  on: boolean;
  onToggle: (id: string) => void;
  /** Where the shop is, drawn only where the point of the list is that it is
   *  somewhere else. On the city's own list every row would say the same word. */
  showCity?: boolean;
}) {
  return (
    <button
      onClick={() => onToggle(c.id)}
      className={
        "inline-flex h-7 items-center gap-1.5 rounded-[4px] border px-2 text-[12px] " +
        (on
          ? "border-brand bg-brand-soft text-[#5223E0]"
          : "border-line bg-surface text-body hover:bg-canvas")
      }
    >
      {on ? <SalesIcon name="tick" size={12} /> : null}
      {/*
        B3-16 — the retention band, as a dot.

        This list fetched `health_score` and drew nothing with it for as long
        as it has existed, so a manager arranging somebody's day could not see
        which of these shops had gone quiet without opening each one. A dot
        rather than a pill because the chip is a picker and a second word in it
        would crowd out the name; the band is on the title, which is where
        somebody looks once they have noticed a colour. No dot at all where
        there is no band — a shop that has never ordered has not stopped
        buying.
      */}
      {c.healthBand ? (
        <span
          aria-hidden
          title={BAND_TITLE[c.healthBand]}
          className={
            "inline-block h-1.5 w-1.5 rounded-full " +
            (c.healthBand === "active"
              ? "bg-success"
              : c.healthBand === "at-risk"
                ? "bg-warn"
                : "bg-danger")
          }
        />
      ) : null}
      {c.name}
      {/* WHAT KIND OF ACCOUNT IT IS, where it is not an ordinary customer. A
          salesman's day is a mix of shops we invoice, shops a distributor
          invoices and shops that have never bought anything, and the three are
          three different calls to make. Silent on a direct customer, because
          that is the ordinary case and a word on every chip is no word at all. */}
      {c.kind === "lead" ? (
        <span className="text-muted">lead</span>
      ) : c.thirdParty ? (
        <span className="text-muted">third party</span>
      ) : null}
      {showCity && c.city ? <span className="text-muted">{c.city}</span> : null}
      {!c.hasGps ? <span className="text-warn-ink">no pin</span> : null}
    </button>
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
  /* THE ESCAPE HATCH, shut by default. A day is a city — that is the model the
     whole screen rests on — so a shop from somewhere else is a deliberate act
     rather than one more chip in the same list. Opening it is what makes the
     manager's own choice visible to him. */
  const [anywhere, setAnywhere] = React.useState(false);
  const [term, setTerm] = React.useState("");
  const state = row.plan?.dayState;
  const weekend = isSunday(row.date);

  /* The three buckets, and the toggle they all share. Derived here rather than
     inside the panel so the counts on the closed panel's own button are the
     same numbers the open one lists. */
  const proposed = row.city.trim();
  const { here, elsewhere, unplaceable } = splitBook(book, proposed);
  const othersShown = term.trim()
    ? elsewhere.filter((c) => c.name.toLowerCase().includes(term.trim().toLowerCase()))
    : elsewhere;

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

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
            {/* A COMBOBOX, not a `datalist`. The browser draws a datalist's
                popup itself — none of this product's type, spacing or shadow,
                sized to its own content rather than to the field, and opened
                UPWARD across the page header on the rows low down the week. It
                read as a spellchecker's suggestion rather than as a control
                somebody is meant to choose from. Free text is kept, because
                `customers.city` holds whatever the sheet typed and proposing a
                town nobody has sold in yet is an ordinary Tuesday. */}
            <ComboBox
              value={row.city}
              options={cities}
              onChange={onCity}
              disabled={busy || state === "agreed"}
              label={`City for ${shortDay(row.date)}`}
              placeholder="Propose a city"
              emptyHint="No city in his book matches — what you type is still proposed"
              title={
                state === "agreed"
                  ? "He has agreed this day. He picks the shops next."
                  : "The unit you propose. He divides it into a beat himself."
              }
              className="w-[220px] flex-none"
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
          {/* SPLIT BY THE CITY THAT WAS PROPOSED. The list used to be the whole
              book, so a day in Gwalior was arranged from a list containing
              every shop in Bhopal — and nothing said so, which made it look
              like the salesman had a lot of shops in Gwalior. */}
          {here.length ? (
            <div className="flex max-h-[240px] flex-wrap gap-1.5 overflow-y-auto">
              {here.map((c) => (
                <ShopChip key={c.id} c={c} on={picked.includes(c.id)} onToggle={toggle} />
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted">
              {book.length === 0
                ? "His book is empty."
                : proposed
                  ? `No shop in his book is recorded in ${proposed}.`
                  : "His book is empty."}
            </p>
          )}

          {/* A SHOP NOBODY CAN PLACE IS NAMED, never quietly filed under
              "somewhere else". "This one is in Bhopal" is a reason not to go
              today; "nobody ever recorded where this shop is" is a gap in the
              book, and hiding it inside a longer list is how it stays a gap.
              It is offered for picking anyway — the salesman may well know
              exactly where it is. */}
          {unplaceable.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-warn-ink">
                {plural(unplaceable.length, "shop")} with no city, area or beat recorded — nothing
                can place {unplaceable.length === 1 ? "it" : "them"}
              </summary>
              <div className="mt-1.5 flex max-h-[160px] flex-wrap gap-1.5 overflow-y-auto">
                {unplaceable.map((c) => (
                  <ShopChip key={c.id} c={c} on={picked.includes(c.id)} onToggle={toggle} />
                ))}
              </div>
            </details>
          ) : null}

          {/* ADDING ONE FROM ANYWHERE — the manager's own exception, made
              deliberate rather than impossible. A shop on the road to the city,
              or one the customer asked for by name, is a real reason; what it
              must not be is the default, which is what an unfiltered list made
              it. */}
          {proposed && elsewhere.length ? (
            <div className="mt-2">
              {anywhere ? (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      value={term}
                      onChange={(e) => setTerm(e.target.value)}
                      placeholder={`Search his other ${elsewhere.length} shops`}
                      className="h-7 w-[260px] rounded-[4px] border border-line bg-surface px-2 text-[12px] text-ink outline-none focus:border-brand"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setAnywhere(false);
                        setTerm("");
                      }}
                      className="cursor-pointer text-[12px] text-muted hover:text-ink"
                    >
                      Done
                    </button>
                  </div>
                  <div className="mt-1.5 flex max-h-[160px] flex-wrap gap-1.5 overflow-y-auto">
                    {othersShown.length ? (
                      othersShown.map((c) => (
                        <ShopChip
                          key={c.id}
                          c={c}
                          on={picked.includes(c.id)}
                          onToggle={toggle}
                          showCity
                        />
                      ))
                    ) : (
                      <span className="text-[12px] text-muted">No shop of his matches that.</span>
                    )}
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setAnywhere(true)}
                  className="cursor-pointer text-[12px] text-[#5223E0] hover:underline"
                >
                  Add a shop from somewhere else ({elsewhere.length})
                </button>
              )}
            </div>
          ) : null}

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
