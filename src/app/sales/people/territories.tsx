"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Modal } from "@/components/ui/overlays";
import { setSalesmanTerritories } from "@/lib/actions/sales";
import type { PlaceTree, Salesman, StateNode } from "@/lib/services/sales-service";
import { Button, Pill } from "../parts";

/**
 * Where a salesman WORKS, and the dialog that sets it.
 *
 * **A territory narrows a book. It is not a permission**, and the screen says
 * so, because the two look alike and reading this as access control is how
 * somebody later removes a real check believing it redundant. He sees his own
 * customers and his own leads either way — a territory only decides which of
 * them are in front of him.
 *
 * **Nothing picked now means an empty handset**, and the dialog says that in
 * red rather than in passing. It meant "his whole book" until this landed, and
 * the reversal is the point of the feature: an unallocated salesman carrying
 * five thousand shops is what it exists to stop. What makes it safe is that
 * nobody can do it by accident — the state of "no area" is drawn as a warning
 * on this screen, counted on the one behind it, and explained on the handset.
 *
 * **IT IS A TREE, PICKED FROM THE TOP.** A city belongs to a state, so a state
 * is picked first and its own cities appear underneath it. Flat lists are what
 * this had, and on the real book that meant every city value in the country
 * under one heading — several hundred, most of them not cities at all but whole
 * postal addresses the sheet dropped into the column. Nesting does not clean
 * that and cannot; it makes it reachable, because a state's worth of it is a
 * list somebody can search and the country's is not.
 *
 * **The narrowest pick in a branch is the allocation.** A state with no cities
 * ticked under it means the whole state; tick one city and it means that city.
 * The wider place is then the PATH to the narrower one rather than a second
 * grant — stored as both, the clause would OR them and hand him the whole
 * state, which is the opposite of what picking a city meant. `setSalesmanTerritories`
 * does the pruning, on the server, because a server action is a URL.
 *
 * The places offered are the ones the BOOK uses, read off `customers` rather
 * than kept as a list of their own. A list of its own would offer a city no
 * customer is in, and a territory that matches nothing is a book that goes
 * quietly empty.
 */

type Pick = { kind: "state" | "city" | "beat"; value: string; parent: string };

/** Where a city list stops being scannable and needs a search box. */
const SEARCH_ABOVE = 12;

const same = (a: Pick, b: Pick) =>
  a.kind === b.kind &&
  a.value.toLowerCase() === b.value.toLowerCase() &&
  a.parent.toLowerCase() === b.parent.toLowerCase();

const count = (n: number) => n.toLocaleString("en-IN");

export function Territories({
  salesman,
  places,
}: {
  salesman: Salesman;
  places: PlaceTree;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<Pick[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin() {
    /* What is STORED is the leaves, so a city row arrives with no state row
       beside it — and the state has to be re-ticked here or its section would
       not draw at all. Re-deriving the path from the leaf is the inverse of the
       pruning the action does on the way in. */
    const stored = (salesman.territories ?? []).map((t) => ({
      kind: t.kind as Pick["kind"],
      value: t.value,
      parent: t.parent ?? "",
    }));
    const path: Pick[] = [];
    for (const t of stored) {
      if (t.kind === "city" && t.parent) {
        path.push({ kind: "state", value: t.parent, parent: "" });
      }
      if (t.kind === "beat" && t.parent) {
        const city = t.parent;
        const state = places.states.find((s) =>
          s.cities.some((c) => c.city.toLowerCase() === city.toLowerCase()),
        );
        path.push({ kind: "city", value: city, parent: state?.state ?? "" });
        if (state) path.push({ kind: "state", value: state.state, parent: "" });
      }
    }
    const all = [...stored, ...path].filter(
      (t, i, list) => list.findIndex((o) => same(o, t)) === i,
    );

    setPicked(all);
    setError(null);
    setOpen(true);
  }

  const has = (p: Pick) => picked.some((x) => same(x, p));

  /** Ticking adds; unticking takes the branch below it as well. */
  function flip(p: Pick) {
    setPicked((current) => {
      if (!current.some((x) => same(x, p))) return [...current, p];

      const dropped = new Set<string>([p.value.toLowerCase()]);
      /* A state carries its cities out, and those cities carry their beats. */
      if (p.kind === "state") {
        for (const c of current) {
          if (c.kind === "city" && c.parent.toLowerCase() === p.value.toLowerCase()) {
            dropped.add(c.value.toLowerCase());
          }
        }
      }
      return current.filter(
        (x) =>
          !same(x, p) &&
          !(x.parent && dropped.has(x.parent.toLowerCase())),
      );
    });
  }

  const pickedStates = places.states.filter((s) =>
    has({ kind: "state", value: s.state, parent: "" }),
  );

  const citiesIn = (state: StateNode) =>
    picked.filter(
      (p) => p.kind === "city" && p.parent.toLowerCase() === state.state.toLowerCase(),
    );

  /**
   * HOW MANY SHOPS THIS ACTUALLY REACHES, which is the only number that tells
   * somebody whether they have allocated what they meant to. "Maharashtra,
   * Pune" reads like a narrowing either way; 1,204 shops and 210 shops do not.
   */
  const covered = pickedStates.reduce((total, state) => {
    const cities = citiesIn(state);
    if (!cities.length) return total + state.shops;

    return (
      total +
      cities.reduce((sum, c) => {
        const node = state.cities.find(
          (x) => x.city.toLowerCase() === c.value.toLowerCase(),
        );
        if (!node) return sum;
        const beats = picked.filter(
          (b) => b.kind === "beat" && b.parent.toLowerCase() === c.value.toLowerCase(),
        );
        if (!beats.length) return sum + node.shops;
        return (
          sum +
          beats.reduce(
            (bs, b) =>
              bs +
              (node.beats.find((x) => x.beat.toLowerCase() === b.value.toLowerCase())
                ?.shops ?? 0),
            0,
          )
        );
      }, 0)
    );
  }, 0);

  /** The sentence, in the shape somebody would say it out loud. */
  const summary = pickedStates
    .map((state) => {
      const cities = citiesIn(state);
      if (!cities.length) return `the whole of ${state.state}`;
      const named = cities.map((c) => {
        const beats = picked.filter(
          (b) => b.kind === "beat" && b.parent.toLowerCase() === c.value.toLowerCase(),
        );
        return beats.length ? `${c.value} (${beats.map((b) => b.value).join(", ")})` : c.value;
      });
      return `${named.join(", ")} in ${state.state}`;
    })
    .join("; ");

  async function save() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setSalesmanTerritories({
        salesmanId: salesman.id,
        territories: picked,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  const nothing = places.states.length === 0;

  return (
    <>
      <Button size="sm" onClick={begin}>
        Where they work
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Where ${salesman.name} works`}
        width={680}
        footer={
          <div className="flex items-center justify-between gap-4">
            <p className="text-[12px] text-muted">
              {picked.length
                ? `About ${count(covered)} of ${count(salesman.customerCount ?? 0)} shops in their book`
                : "No area picked"}
            </p>
            <div className="flex gap-2">
              <Button tone="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button tone="primary" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        }
      >
        <p className="text-[13px] text-pretty text-muted">
          This narrows what their handset shows to their own customers and leads in these
          places. It does not give them anybody else&apos;s — who may see a record is decided
          by whose book it is in, and nothing here changes that.
        </p>

        {nothing ? (
          <p className="mt-4 text-[13px] text-muted">
            No customer record names a state yet, so there is nothing to divide up. Places
            come from the book itself rather than a list of their own — a separate list
            would offer somewhere no customer is.
          </p>
        ) : (
          <>
            <Step n={1} title="Pick the states they cover" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {places.states.map((s) => (
                <Chip
                  key={s.state}
                  on={has({ kind: "state", value: s.state, parent: "" })}
                  onClick={() => flip({ kind: "state", value: s.state, parent: "" })}
                  label={s.state}
                  meta={count(s.shops)}
                />
              ))}
            </div>

            <Step
              n={2}
              title="Narrow to cities, if you want to"
              hint="A state with nothing ticked under it means the whole state."
            />

            {pickedStates.length === 0 ? (
              <p className="mt-2 rounded-[4px] border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">
                Pick a state above and its cities appear here.
              </p>
            ) : (
              <div className="mt-2 flex flex-col gap-3">
                {pickedStates.map((state) => (
                  <StateSection
                    key={state.state}
                    state={state}
                    picked={picked}
                    has={has}
                    flip={flip}
                  />
                ))}
              </div>
            )}

            {/* THE ANSWER, said back before it is written. A list of ticks is
                not a review; a sentence naming what it comes to is. */}
            <div
              className={
                "mt-5 rounded-[4px] border px-3 py-2.5 text-[13px] text-pretty " +
                (picked.length
                  ? "border-line bg-canvas text-body"
                  : "border-danger bg-danger-soft text-danger")
              }
            >
              {picked.length ? (
                <>
                  Their handset will show their own customers and leads in{" "}
                  <span className="font-medium text-ink">{summary}</span> — about{" "}
                  {count(covered)} shops. The rest of their book is still theirs; it is
                  just not on the list.
                </>
              ) : (
                <>
                  <span className="font-medium">
                    With no area picked their handset shows no customers at all.
                  </span>{" "}
                  Nothing of theirs is lost and nothing is deleted — the list is simply
                  empty until an area is set, and the app tells them so.
                </>
              )}
            </div>

            {places.statelessShops > 0 ? (
              <p className="mt-3 text-[12px] text-pretty text-muted">
                {count(places.statelessShops)} shops name no state at all, so no territory
                can reach them. They need a state on the customer record before they can be
                allocated to anybody.
              </p>
            ) : null}
          </>
        )}

        {error ? (
          <p className="mt-3 rounded-[4px] bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        ) : null}
      </Modal>
    </>
  );
}

/** The numbered step heading — the dialog is a sequence and it should look like one. */
function Step({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="mt-5 flex items-baseline gap-2 border-b border-line pb-1.5">
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-white">
        {n}
      </span>
      <span className="text-[13px] font-medium text-ink">{title}</span>
      {hint ? <span className="text-[12px] text-muted">{hint}</span> : null}
    </div>
  );
}

/** One picked state, and everything inside it. */
function StateSection({
  state,
  picked,
  has,
  flip,
}: {
  state: StateNode;
  picked: Pick[];
  has: (p: Pick) => boolean;
  flip: (p: Pick) => void;
}) {
  const [query, setQuery] = React.useState("");

  const cities = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.cities;
    return state.cities.filter((c) => c.city.toLowerCase().includes(q));
  }, [state.cities, query]);

  const pickedCities = picked.filter(
    (p) => p.kind === "city" && p.parent.toLowerCase() === state.state.toLowerCase(),
  );
  const whole = pickedCities.length === 0;

  return (
    <section className="rounded-[4px] border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <span className="text-[13px] font-medium text-ink">{state.state}</span>
        <span className="text-[12px] text-muted">
          {whole ? (
            <Pill tone="brand">Whole state · {count(state.shops)} shops</Pill>
          ) : (
            <Pill>
              {pickedCities.length} of {state.cities.length} cities
            </Pill>
          )}
        </span>
      </header>

      <div className="p-3">
        {state.cities.length === 0 ? (
          <p className="text-[12px] text-muted">
            No customer in {state.state} names a city, so the whole state is the only thing
            to allocate.
          </p>
        ) : (
          <>
            {state.cities.length > SEARCH_ABOVE ? (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${count(state.cities.length)} places in ${state.state}`}
                className="mb-2 h-8 w-full rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
              />
            ) : null}

            {/* Capped in height rather than in rows: the long tail here is
                address strings, and a list that cannot be scrolled past is
                a dialog somebody has to scroll a thousand rows of. */}
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {cities.length === 0 ? (
                <p className="py-2 text-[12px] text-muted">
                  Nothing in {state.state} matches “{query}”.
                </p>
              ) : (
                cities.map((c) => {
                  const on = has({ kind: "city", value: c.city, parent: state.state });
                  const beats = c.beats.length > 1 ? c.beats : [];
                  return (
                    <div key={c.city}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-[4px] px-1.5 py-1 hover:bg-canvas">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            flip({ kind: "city", value: c.city, parent: state.state })
                          }
                          className="mt-[3px] size-3.5 shrink-0 accent-[#5223E0]"
                        />
                        <span className="min-w-0 flex-1 text-[13px] text-pretty text-body">
                          {c.city}
                        </span>
                        <span className="shrink-0 text-[12px] text-muted">
                          {count(c.shops)}
                        </span>
                      </label>

                      {on && beats.length ? (
                        <div className="mt-0.5 mb-1 ml-6 flex flex-wrap gap-1.5 border-l border-line pl-2.5">
                          {beats.map((b) => (
                            <Chip
                              key={b.beat}
                              small
                              on={has({ kind: "beat", value: b.beat, parent: c.city })}
                              onClick={() =>
                                flip({ kind: "beat", value: b.beat, parent: c.city })
                              }
                              label={b.beat}
                              meta={count(b.shops)}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Chip({
  on,
  onClick,
  label,
  meta,
  small,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  meta?: string;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={
        "inline-flex max-w-full items-center gap-1.5 rounded-[4px] border px-2.5 " +
        (small ? "h-7 text-[12px] " : "h-8 text-[13px] ") +
        (on
          ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
          : "border-line bg-surface text-body hover:bg-canvas")
      }
    >
      <span className="truncate">{label}</span>
      {meta ? (
        <span className={on ? "text-[#5223E0]/70" : "text-muted"}>{meta}</span>
      ) : null}
    </button>
  );
}

/**
 * The cell that shows it on the team table.
 *
 * The unallocated case is a WARNING now rather than a neutral pill, because
 * what it means has reversed: it used to say "sees everything", and it now says
 * "sees nothing". A cell that reads the same in both worlds is how somebody
 * misses a handset they have switched off.
 */
export function WorksCell({ salesman }: { salesman: Salesman }) {
  const list = salesman.territories ?? [];
  if (!list.length) {
    return (
      <span title="No area is set, so their handset shows no customers at all. Set one with Where they work.">
        <Pill tone="danger">No area · empty handset</Pill>
      </span>
    );
  }

  /* The stored rows are the LEAVES, so a city already implies its state and
     printing both would read as two places. */
  return <>{list.map((t) => t.value).join(", ")}</>;
}
