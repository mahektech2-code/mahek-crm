"use client";

import * as React from "react";
import { decodePlace, encodePlace, samePlace, type PlacePick } from "@/lib/lead-places";
import type { PlaceTree, StateNode } from "@/lib/services/sales-service";

/* ---------------------------------------------------------------------------
 * WHERE, PICKED FROM THE TOP — state, then city, then area.
 *
 * It is the territory dialog's tree offered as a FILTER, which is deliberate
 * down to the expressions behind it: `territoryClause` decides both, so the
 * list a manager narrows to Nagpur and the handset of the salesman allocated
 * Nagpur are answering with the same rule about the same spellings. Two
 * readings of one question is how a manager and a salesman come to quote one
 * shop two different towns.
 *
 * A FLAT LIST WAS NEVER AN OPTION. `customers.city` holds whatever the sheet
 * typed — 1,165 distinct strings on the real book, several hundred of them
 * whole postal addresses dropped into the column. Nesting does not clean that
 * and cannot; it makes it REACHABLE, because a state's worth of it is a list
 * somebody can search and the country's is not. The shop counts are the other
 * half of that: the city somebody means is almost always one of the few with a
 * real count, and the long tail below it is addresses.
 *
 * THE NARROWEST PICK IS THE PICK. Ticking a city drops the whole-state pick it
 * sits under rather than sitting beside it — held as both, the clause would OR
 * them and answer with the whole state, which is the opposite of what ticking a
 * city meant and invisible afterwards, because "Maharashtra, Nagpur" reads like
 * a narrowing either way. The same pruning `setSalesmanTerritories` does on the
 * server, done here so the chips say what the list will actually show.
 * ------------------------------------------------------------------------- */

/** Where a city list stops being scannable — the territory dialog's own number. */
const SEARCH_ABOVE = 12;

const count = (n: number) => n.toLocaleString("en-IN");

export function PlacePicker({
  tree,
  picked,
  onChange,
}: {
  tree: PlaceTree;
  /** The encoded paths currently in the URL. */
  picked: string[];
  onChange: (next: string[]) => void;
}) {
  /* WHICH STATE IS OPEN is not the same question as which is picked: somebody
     narrowing to one city has to be able to look inside a state without first
     filtering by the whole of it.
     
     It opens on the state already narrowed to, where there is one, so reopening
     the panel to change a city does not start by asking which state that city
     was in. Initial state from props rather than an effect syncing the two —
     the React Compiler rules here forbid the effect, and a picker that reset
     the open state on every navigation would shut itself the moment somebody
     ticked a city. */
  const [open, setOpen] = React.useState<string | null>(
    decodePlace(picked[0] ?? "")?.state ??
      (tree.states.length === 1 ? tree.states[0].state : null),
  );

  const picks = React.useMemo(
    () => picked.map(decodePlace).filter((p): p is PlacePick => p !== null),
    [picked],
  );

  const has = (p: PlacePick) => picks.some((x) => samePlace(x, p));

  /**
   * Ticking adds and prunes; unticking takes the branch below it with it.
   *
   * Pruning is what keeps a pick honest — see the note at the top. Unticking a
   * state has to drop its cities too, or the filter would go on narrowing to
   * places whose parent the screen no longer shows as ticked.
   */
  function flip(p: PlacePick) {
    const inState = (x: PlacePick) => sameText(x.state, p.state);
    /* A CITY IS COMPARED WITH ITS STATE, never on its own. Two states can each
       hold a town of one name — which is the whole reason a pick is a path —
       so a beat ticked under one Nagpur must not prune the other Nagpur. */
    const inCity = (x: PlacePick) => inState(x) && sameText(x.city, p.city);

    const next = has(p)
      ? /* Unticking takes the branch below it with it: a pick whose parent the
           screen no longer shows as ticked is one still narrowing the list with
           nothing on the screen accounting for it. */
        picks.filter((x) => {
          if (samePlace(x, p)) return false;
          if (p.beat) return true;
          if (p.city) return !inCity(x);
          return !inState(x);
        })
      : [
          ...picks.filter((x) => {
            /* The wider pick this one sits under is the PATH to it, never a
               second grant — held as both, the clause ORs them and answers with
               the wider place, which is the opposite of what the narrower tick
               meant. And the narrower ones under it are superseded: ticking a
               whole city after picking two of its areas means the city. */
            if (p.beat) return !(inCity(x) && !x.beat);
            if (p.city) return !(inState(x) && !x.city) && !(inCity(x) && x.beat);
            return !inState(x);
          }),
          p,
        ];
    onChange(next.map(encodePlace));
  }

  if (!tree.states.length) {
    return (
      <p className="text-[12px] text-pretty text-muted">
        No lead names a state yet, so there is nothing to narrow by. Places come from the
        book itself rather than a list of their own — a list of its own would offer
        somewhere no shop is.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {tree.states.map((s) => {
          const whole = has({ state: s.state });
          const inside = picks.filter((p) => sameText(p.state, s.state) && p.city).length;
          return (
            <StateChip
              key={s.state}
              label={s.state}
              meta={inside ? `${inside} picked` : count(s.shops)}
              on={whole || inside > 0}
              open={open === s.state}
              onOpen={() => setOpen(open === s.state ? null : s.state)}
              onTick={() => flip({ state: s.state })}
              ticked={whole}
            />
          );
        })}
      </div>

      {open ? (
        <CitiesIn
          state={tree.states.find((s) => s.state === open)!}
          picked={picked}
          has={has}
          flip={flip}
        />
      ) : (
        <p className="text-[12px] text-muted">
          Tick a state to narrow to it, or press its name to pick cities inside it.
        </p>
      )}

      {tree.statelessShops > 0 ? (
        <p className="text-[12px] text-pretty text-muted">
          {count(tree.statelessShops)} of these name no state at all, so no place filter
          can reach them. They need a state on the record first.
        </p>
      ) : null}
    </div>
  );
}

/** One open state, and its cities. */
function CitiesIn({
  state,
  picked,
  has,
  flip,
}: {
  state: StateNode;
  /** The encoded paths, for counting what is picked INSIDE a city. */
  picked: string[];
  has: (p: PlacePick) => boolean;
  flip: (p: PlacePick) => void;
}) {
  const [query, setQuery] = React.useState("");

  const cities = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.cities;
    return state.cities.filter((c) => c.city.toLowerCase().includes(q));
  }, [state.cities, query]);

  if (!state.cities.length) {
    return (
      <p className="rounded-[4px] border border-dashed border-line px-3 py-3 text-[12px] text-muted">
        No lead in {state.state} names a city, so the whole state is the only thing to
        narrow by.
      </p>
    );
  }

  return (
    <div className="rounded-[4px] border border-line bg-canvas p-2">
      {state.cities.length > SEARCH_ABOVE ? (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${count(state.cities.length)} places in ${state.state}`}
          className="mb-1.5 h-8 w-full rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
        />
      ) : null}

      {/* Capped in height rather than in rows: the long tail is address
          strings, and a list that cannot be scrolled past is a panel somebody
          has to scroll a thousand rows of. */}
      <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
        {!cities.length ? (
          <p className="px-1.5 py-2 text-[12px] text-muted">
            Nothing in {state.state} matches “{query}”.
          </p>
        ) : (
          cities.map((c) => {
            const on = has({ state: state.state, city: c.city });
            /* OPEN WHILE ANYTHING INSIDE IT IS PICKED, not only while the city
               itself is — ticking an area PRUNES the city pick it sits under,
               so reading the tick alone made the area chips vanish under the
               finger that ticked one, leaving an unticked city and no way back
               to the areas. */
            const insideCount = picked
              .map(decodePlace)
              .filter(
                (x): x is PlacePick =>
                  x !== null &&
                  Boolean(x.beat) &&
                  sameText(x.state, state.state) &&
                  sameText(x.city, c.city),
              ).length;
            /* One area under a city is not a narrowing — it is the city said
               twice. The territory dialog draws the same rule. */
            const areas = (on || insideCount > 0) && c.beats.length > 1 ? c.beats : [];
            return (
              <div key={c.city}>
                <label className="flex cursor-pointer items-start gap-2 rounded-[4px] px-1.5 py-1 hover:bg-surface">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => flip({ state: state.state, city: c.city })}
                    className="mt-[3px] size-3.5 shrink-0 accent-[#6835FB]"
                  />
                  <span className="min-w-0 flex-1 text-[13px] text-pretty text-body">
                    {c.city}
                  </span>
                  <span className="shrink-0 text-[12px] text-muted">{count(c.shops)}</span>
                </label>

                {areas.length ? (
                  <div className="mt-0.5 mb-1 ml-6 flex flex-wrap gap-1 border-l border-line pl-2">
                    {areas.map((b) => (
                      <button
                        key={b.beat}
                        type="button"
                        aria-pressed={has({ state: state.state, city: c.city, beat: b.beat })}
                        onClick={() =>
                          flip({ state: state.state, city: c.city, beat: b.beat })
                        }
                        className={
                          "inline-flex h-6 max-w-full items-center gap-1 rounded-[4px] border px-2 text-[12px] " +
                          (has({ state: state.state, city: c.city, beat: b.beat })
                            ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                            : "border-line bg-surface text-body hover:bg-canvas")
                        }
                      >
                        <span className="truncate">{b.beat}</span>
                        <span className="text-muted">{count(b.shops)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {/* The rung nobody has filled in yet, said in words rather
                    than drawn as an empty row. `beat` and `area` are empty on
                    every shop on the real book, so a city that offers no areas
                    is the ordinary case and not a screen that failed. */}
                {(on || insideCount > 0) && !areas.length ? (
                  <p className="mt-0.5 mb-1 ml-6 border-l border-line pl-2 text-[11px] text-muted">
                    No areas recorded inside {c.city} yet.
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** A state: a tick that narrows, and a name that opens. Two acts, one chip. */
function StateChip({
  label,
  meta,
  on,
  ticked,
  open,
  onTick,
  onOpen,
}: {
  label: string;
  meta: string;
  on: boolean;
  ticked: boolean;
  open: boolean;
  onTick: () => void;
  onOpen: () => void;
}) {
  return (
    <span
      className={
        "inline-flex h-8 max-w-full items-center rounded-[4px] border " +
        (on
          ? "border-brand bg-brand-soft text-[#5223E0]"
          : open
            ? "border-brand bg-surface text-body"
            : "border-line bg-surface text-body")
      }
    >
      <label className="flex cursor-pointer items-center pl-2" title={`Narrow to the whole of ${label}`}>
        <input
          type="checkbox"
          checked={ticked}
          onChange={onTick}
          className="size-3.5 accent-[#6835FB]"
          aria-label={`The whole of ${label}`}
        />
      </label>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        title={`Pick cities inside ${label}`}
        className="flex cursor-pointer items-center gap-1.5 px-2 text-[13px]"
      >
        <span className="truncate font-medium">{label}</span>
        <span className={on ? "text-[#5223E0]/70" : "text-muted"}>{meta}</span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={"flex-none text-muted transition-transform " + (open ? "rotate-180" : "")}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </span>
  );
}

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
