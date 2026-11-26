"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { splitBookMany } from "@/lib/city-match";
import { citiesInWords, sameCityList } from "@/lib/journey-cities";
import { CityListInput } from "./city-list-input";
import { addDays } from "@/lib/business-date";
import { dayWhere } from "@/lib/journey-days";
import { dayEdit, officeMayEdit, saveStopsLabel, type DayEdit } from "@/lib/journey-day-edit";
import { answerRefusal, editJourneyDayStops, proposeJourneyDays } from "@/lib/actions/sales";
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
import { SalesIcon } from "@/components/console/icons";
import { Banner, Button, Empty, Pill } from "@/components/console/parts";
import { plural } from "@/components/console/words";

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
 *
 * The picker EDITS a day: what is already on it stays unless somebody unticks
 * it, and the whole list is drawn on the day whether the picker is open or not.
 */

const HORIZONS = [7, 15, 30] as const;

type DayRow = {
  date: string;
  plan: JourneyPlan | null;
  /** The PRIMARY city of what the manager is proposing — the first of `cities`. */
  city: string;
  /** Every city the manager is proposing for this day, in order, before saving. */
  cities: string[];
};

export function JourneysScreen({
  selected,
  from,
  horizon,
  plans,
  book,
  cities,
  today,
  stay = "",
}: {
  selected: Salesman | null;
  from: string;
  horizon: number;
  plans: JourneyPlan[];
  book: BookCustomer[];
  /** Where he works, then the cities his own book names — a shortcut, not a limit. */
  cities: string[];
  /** The business date. A planned day that has gone by is not edited. */
  today: string;
  /** Appended to the links back into this view — `&in=team` keeps it in its modal. */
  stay?: string;
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
  const [drafts, setDrafts] = React.useState<Record<string, string[]>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const days: DayRow[] = React.useMemo(
    () =>
      dates.map((date) => {
        const plan = plans.find((p) => p.planDate === date) ?? null;
        const cities = drafts[date] ?? plan?.cities ?? [];
        return { date, plan, city: cities[0] ?? "", cities };
      }),
    [dates, plans, drafts],
  );

  const refused = days.filter((d) => d.plan?.dayState === "refused");
  const proposed = days.filter((d) => d.plan?.dayState === "proposed");
  const agreed = days.filter((d) => d.plan?.dayState === "agreed");
  const planned = days.filter((d) => d.plan?.dayState === "planned");

  /* A planned day is not proposed over — its cities are saved with its shops. */
  const dirty = days.filter(
    (d) =>
      d.plan?.dayState !== "planned" &&
      d.cities.length > 0 &&
      !sameCityList(d.cities, d.plan?.cities ?? []),
  );

  function setCities(date: string, cities: string[]) {
    setDrafts((d) => ({ ...d, [date]: cities }));
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
        next[d.date] = week[i % 7].cities;
      });
      return next;
    });
  }

  async function propose() {
    if (!selected) return;
    const sending = dirty.map((d) => ({
      planDate: d.date,
      city: d.cities[0],
      cities: d.cities,
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
    cities?: string[],
  ) {
    setBusy(true);
    setError(null);
    try {
      const result = await answerRefusal({ planId, take, city: cities?.[0], cities });
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
  async function pickFromOffice(
    date: string,
    cities: string[],
    add: string[],
    remove: string[],
  ): Promise<boolean> {
    if (!selected) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await editJourneyDayStops({
        salesmanId: selected.id,
        planDate: date,
        city: cities[0],
        cities,
        add,
        remove,
      });
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setDrafts((current) => {
        const next = { ...current };
        delete next[date];
        return next;
      });
      toast.push(result.message ?? "Saved.");
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* ------------------------------------------------------- the controls */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            From
          </span>
          <input
            type="date"
            value={from}
            onChange={(e) => go(router, stay, selected?.id ?? "", e.target.value, horizon)}
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
                onClick={() => go(router, stay, selected?.id ?? "", from, h)}
                className={
                  "h-8.5 cursor-pointer rounded-[4px] border px-2.5 text-sm font-medium " +
                  (horizon === h
                    ? "border-brand bg-brand-soft text-brand-hover"
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
                if (n >= 1 && n <= 31) go(router, stay, selected?.id ?? "", from, n);
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
                {book.length || cities.length
                  ? `${cities.length} cities to pick from`
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
                  onCities={(c) => setCities(d.date, c)}
                  onAnswer={(take, cities) =>
                    d.plan && void answer(d.date, d.plan.id, take, cities)
                  }
                  editable={officeMayEdit(d.plan, today)}
                  onPickFromOffice={(add, remove) => pickFromOffice(d.date, d.cities, add, remove)}
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
  locked,
}: {
  c: BookCustomer;
  on: boolean;
  /** Already visited or skipped — on the day for good. */
  locked?: boolean;
  onToggle: (id: string) => void;
  /** Where the shop is, drawn only where the point of the list is that it is
   *  somewhere else. On the city's own list every row would say the same word. */
  showCity?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(c.id)}
      disabled={locked}
      aria-pressed={on}
      title={locked ? "Already visited or skipped, so it stays on the day." : undefined}
      className={
        "inline-flex h-7 items-center gap-1.5 rounded-[4px] border px-2 text-[12px] " +
        (on
          ? "border-brand bg-brand-soft text-brand-hover"
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
  onCities,
  onAnswer,
  editable,
  onPickFromOffice,
}: {
  row: DayRow;
  cities: string[];
  book: BookCustomer[];
  busy: boolean;
  onCities: (cities: string[]) => void;
  onAnswer: (take: "counter" | "other", cities?: string[]) => void;
  /** False on a planned day the salesman picked, or one that has gone by. */
  editable: boolean;
  /** Resolves true once saved, which is when the ticks stop being a draft. */
  onPickFromOffice: (add: string[], remove: string[]) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState(false);
  /* ONLY WHAT HAS BEEN CHANGED IS HELD. What is on the day comes from the
     server every render, so a reload, a tab switch or a reopened picker starts
     from the saved list rather than from nothing. */
  const [added, setAdded] = React.useState<string[]>([]);
  const [removed, setRemoved] = React.useState<string[]>([]);
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
  /* `proposed` is the PRIMARY city — whether there is one at all; `where` says every
     city; the shops listed are those in ANY of them. */
  const proposed = row.city.trim();
  const where = citiesInWords(row.cities);
  const { here, elsewhere, unplaceable } = splitBookMany(book, row.cities);
  const othersShown = term.trim()
    ? elsewhere.filter((c) => c.name.toLowerCase().includes(term.trim().toLowerCase()))
    : elsewhere;

  const stops = row.plan?.stops ?? [];
  const edit = dayEdit(stops, added, removed);
  const citiesChanged = row.cities.length > 0 && !sameCityList(row.cities, row.plan?.cities ?? []);
  /* A proposed or agreed day that already has shops can be saved as it stands,
     which is what moves it on to planned. */
  const canSave =
    edit.added.length > 0 ||
    edit.removed.length > 0 ||
    (edit.total > 0 && (citiesChanged || state === "proposed" || state === "agreed"));

  const toggle = (id: string) => {
    if (edit.locked.has(id)) return;
    const flip = (prev: string[]) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    if (edit.saved.has(id)) setRemoved(flip);
    else setAdded(flip);
  };

  async function save() {
    if (!(await onPickFromOffice(edit.added, edit.removed))) return;
    setAdded([]);
    setRemoved([]);
  }

  const chip = (c: BookCustomer, showCity?: boolean) => (
    <ShopChip
      key={c.id}
      c={c}
      on={edit.selected.has(c.id)}
      locked={edit.locked.has(c.id)}
      onToggle={toggle}
      showCity={showCity}
    />
  );

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

        {state === "planned" && !editable ? (
          <span className="min-w-0 flex-1 text-[13px] text-body">
            {(row.plan && dayWhere(row.plan).text) ?? "Arranged"} ·{" "}
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
            <CityListInput
              value={row.cities}
              options={cities}
              onChange={onCities}
              disabled={busy || state === "agreed"}
              label={`City for ${shortDay(row.date)}`}
              placeholder="Propose a city"
              emptyHint="No allocated or book city matches — what you type is still proposed"
              title={
                state === "planned"
                  ? "Add a city to pick its shops. Saved when you save the shops."
                  : state === "agreed"
                  ? "He has agreed this day. He picks the shops next."
                  : "The unit you propose. He divides it into a beat himself."
              }
              className="w-[330px] flex-none"
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
              ) : state === "planned" ? (
                plural(stops.length, "stop") + " arranged"
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
              disabled={busy || !row.cities.length || sameCityList(row.cities, row.plan?.cities ?? [])}
              title={
                !row.cities.length
                  ? "Type a different city above to put it back to him."
                  : undefined
              }
              onClick={() => onAnswer("other", row.cities)}
            >
              Propose instead
            </Button>
          </span>
        ) : null}

        {/* CITY FIRST, THEN SHOPS. With no city the list was the whole book
            and the day saved with no city on it, so every screen afterwards —
            his handset included — said "No city named" above shops plainly in
            one town. The city in the box beside it is what the list is cut by
            AND what is saved onto the day with the shops. */}
        {editable ? (
          <Button
            size="sm"
            tone="quiet"
            disabled={busy || (!open && !proposed && !stops.length)}
            title={
              !proposed && !stops.length
                ? "Choose the city first — the shops listed are that city's."
                : undefined
            }
            onClick={() => setOpen((o) => !o)}
          >
            {open
              ? "Close"
              : stops.length
                ? "Add or remove shops"
                : proposed
                  ? `Pick shops in ${where}`
                  : "Choose a city to pick shops"}
          </Button>
        ) : null}
      </div>

      {stops.length || edit.added.length ? (
        <DayList
          stops={stops}
          book={book}
          edit={edit}
          onToggle={open && editable && !busy ? toggle : null}
        />
      ) : null}

      {open && editable && (proposed || stops.length) ? (
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
          {!proposed ? (
            <p className="text-[13px] text-muted">Choose a city above to add shops.</p>
          ) : here.length ? (
            <>
              <p className="mb-1 text-[12px] text-muted">
                Shops in {where} — {here.filter((c) => edit.selected.has(c.id)).length} of{" "}
                {here.length} ticked
              </p>
              <div className="flex max-h-[240px] flex-wrap gap-1.5 overflow-y-auto">
                {here.map((c) => chip(c, row.cities.length > 1))}
              </div>
            </>
          ) : (
            <p className="text-[13px] text-muted">
              {book.length === 0
                ? "His book is empty."
                : proposed
                  ? `No shop in his book is recorded in ${where}.`
                  : "His book is empty."}
            </p>
          )}

          {/* A SHOP NOBODY CAN PLACE IS NAMED, never quietly filed under
              "somewhere else". "This one is in Bhopal" is a reason not to go
              today; "nobody ever recorded where this shop is" is a gap in the
              book, and hiding it inside a longer list is how it stays a gap.
              It is offered for picking anyway — the salesman may well know
              exactly where it is. */}
          {proposed && unplaceable.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-warn-ink">
                {plural(unplaceable.length, "shop")} with no city, area or beat recorded — nothing
                can place {unplaceable.length === 1 ? "it" : "them"}
              </summary>
              <div className="mt-1.5 flex max-h-[160px] flex-wrap gap-1.5 overflow-y-auto">
                {unplaceable.map((c) => chip(c))}
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
                      othersShown.map((c) => chip(c, true))
                    ) : (
                      <span className="text-[12px] text-muted">No shop of his matches that.</span>
                    )}
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setAnywhere(true)}
                  className="cursor-pointer text-[12px] text-brand-hover hover:underline"
                >
                  Add a shop from somewhere else ({elsewhere.length})
                </button>
              )}
            </div>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              tone="primary"
              disabled={busy || !canSave}
              title={canSave ? undefined : "Nothing has been changed."}
              onClick={() => void save()}
            >
              {saveStopsLabel(edit)}
            </Button>
            {edit.added.length || edit.removed.length ? (
              <button
                type="button"
                onClick={() => {
                  setAdded([]);
                  setRemoved([]);
                }}
                className="cursor-pointer text-[12px] text-muted hover:text-ink"
              >
                Undo changes
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

    </div>
  );
}

/* ------------------------------------------------------- what is on the day */

/**
 * Every shop on the day, by name, whether or not the picker is open and whatever
 * city is selected — a shop outside the listed cities must still be seen, or it
 * is one nobody knows is there.
 */
function DayList({
  stops,
  book,
  edit,
  onToggle,
}: {
  stops: JourneyPlan["stops"];
  book: BookCustomer[];
  edit: DayEdit;
  /** Null while the picker is shut: the list is then read, not edited. */
  onToggle: ((id: string) => void) | null;
}) {
  const byId = new Map(book.map((c) => [c.id, c]));
  const removing = new Set(edit.removed);
  const lines = [
    ...stops.map((s) => ({
      id: s.customerId,
      key: s.id,
      name: s.customerName,
      city: s.city,
      mark: edit.locked.has(s.customerId)
        ? s.status
        : removing.has(s.customerId)
          ? "will be removed"
          : "arranged",
    })),
    ...edit.added.map((id) => ({
      id,
      key: id,
      name: byId.get(id)?.name ?? id,
      city: byId.get(id)?.city ?? null,
      mark: "to be added",
    })),
  ];

  return (
    <div className="mt-2 ml-[132px] max-w-[720px] rounded-[6px] border border-line bg-surface">
      <p className="border-b border-divider px-3 py-1.5 text-[12px] font-semibold text-ink">
        {edit.added.length || edit.removed.length
          ? `On this day after saving: ${plural(edit.total, "shop")}`
          : `On this day: ${plural(stops.length, "shop")}`}
      </p>
      <ol className="max-h-[320px] divide-y divide-divider overflow-y-auto">
        {lines.map((line, i) => (
          <li key={line.key} className="flex items-center gap-2 px-3 py-1 text-[12px]">
            <span className="w-6 flex-none text-right text-muted tabular-nums">{i + 1}</span>
            {onToggle ? (
              <input
                type="checkbox"
                checked={edit.selected.has(line.id)}
                disabled={edit.locked.has(line.id)}
                onChange={() => onToggle(line.id)}
                aria-label={`Keep ${line.name} on this day`}
                className="flex-none"
              />
            ) : null}
            <span
              className={
                "min-w-0 flex-1 " +
                (line.mark === "will be removed" ? "text-muted line-through" : "text-ink")
              }
            >
              {line.name}
              {line.city ? <span className="ml-1.5 text-muted">{line.city}</span> : null}
            </span>
            <span
              className={
                "flex-none " +
                (line.mark === "will be removed"
                  ? "text-warn-ink"
                  : line.mark === "to be added"
                    ? "text-brand-hover"
                    : "text-muted")
              }
            >
              {line.mark}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

function go(
  router: ReturnType<typeof useRouter>,
  stay: string,
  salesman: string,
  from: string,
  horizon: number,
) {
  router.push(
    `/sales/journeys?tab=salesman&view=propose&salesman=${salesman}&from=${from}&days=${horizon}${stay}`,
  );
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
