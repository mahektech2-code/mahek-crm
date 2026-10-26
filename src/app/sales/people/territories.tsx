"use client";

import * as React from "react";
import { areasSignature } from "@/lib/territory-signature";
import { splitTownParent, territoryName, townParent } from "@/lib/territory-path";
import { APP_TIMEZONE } from "@/lib/business-date";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Modal } from "@/components/ui/overlays";
import { MultiSelect } from "@/components/ui/multi-select";
import { setSalesmanTerritories } from "@/lib/actions/sales";
import type { DistrictNode, PlaceTree, Salesman, StateNode } from "@/lib/services/sales-service";
import { Button, Pill } from "@/components/console/parts";

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
 * **STATE, THEN DISTRICT, THEN — IF YOU WANT TO — TOWN.** States and districts
 * are two multi-selects, and every picked district opens its towns underneath
 * to narrow it further. The districts and towns are the reviewed location tree
 * every other list of shops narrows by. This used to offer `customers.city`
 * under each state instead — whatever the sheet typed, several hundred values
 * a state, most of them not towns at all but whole postal addresses — and a
 * district is how Mahek actually divides the country.
 *
 * **The narrowest pick in a branch is the allocation.** A state with no
 * district picked means the whole state; a district with no town ticked means
 * the whole district. The wider place is then the PATH to the narrower one
 * rather than a second grant — stored as both, the clause would OR them and
 * hand him the whole state. `setSalesmanTerritories` does the pruning, on the
 * server, because a server action is a URL.
 *
 * **What was picked before districts existed is kept, and shown.** A typed
 * city allocated last month goes on meaning exactly what it meant; it is
 * listed under the states as an earlier pick he can keep or take off, never
 * silently dropped because this dialog no longer offers its kind.
 */

type Pick = { kind: "state" | "district" | "town" | "city" | "beat"; value: string; parent: string };

/** Where a town list stops being scannable and needs a search box. */
const SEARCH_ABOVE = 12;

const fold = (s: string) => s.trim().toLowerCase();

const same = (a: Pick, b: Pick) =>
  a.kind === b.kind && fold(a.value) === fold(b.value) && fold(a.parent) === fold(b.parent);

const count = (n: number) => n.toLocaleString("en-IN");

/** The state a pick sits in — "" for a legacy row that never said. */
function stateOf(p: Pick): string {
  if (p.kind === "state") return p.value;
  if (p.kind === "district" || p.kind === "city") return p.parent;
  if (p.kind === "town") return splitTownParent(p.parent).state;
  return "";
}

const districtPick = (district: string, state: string): Pick => ({
  kind: "district",
  value: district,
  parent: state,
});

/** A district's value in the multi-select: two districts in two states can share a name. */
const districtKey = (district: string, state: string) => `${state}|${district}`;

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
    /* What is STORED is the leaves, so a town arrives with no district or
       state row beside it — and both have to be re-ticked here or their
       sections would not draw at all. Re-deriving the path from the leaf is
       the inverse of the pruning the action does on the way in. */
    const stored: Pick[] = (salesman.territories ?? [])
      .filter((t) => t.kind !== "region")
      .map((t) => ({ kind: t.kind as Pick["kind"], value: t.value, parent: t.parent ?? "" }));
    const path: Pick[] = [];
    for (const t of stored) {
      if (t.kind === "district" && t.parent) {
        path.push({ kind: "state", value: t.parent, parent: "" });
      }
      if (t.kind === "town") {
        const { district, state } = splitTownParent(t.parent);
        if (district && state) {
          path.push(districtPick(district, state));
          path.push({ kind: "state", value: state, parent: "" });
        }
      }
      if (t.kind === "city" && t.parent) {
        path.push({ kind: "state", value: t.parent, parent: "" });
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

  /** Adding is adding; taking a place away takes everything picked under it too. */
  function drop(p: Pick) {
    setPicked((current) => {
      const gone = (x: Pick): boolean => {
        if (same(x, p)) return true;
        if (p.kind === "state") {
          if (x.kind === "beat") {
            /* A beat goes with the typed city it hangs from. */
            return current.some(
              (c) => c.kind === "city" && fold(c.value) === fold(x.parent) && fold(stateOf(c)) === fold(p.value),
            );
          }
          return x.kind !== "state" && fold(stateOf(x)) === fold(p.value);
        }
        if (p.kind === "district") {
          if (x.kind !== "town") return false;
          const { district, state } = splitTownParent(x.parent);
          return fold(district) === fold(p.value) && fold(state) === fold(p.parent);
        }
        if (p.kind === "city") return x.kind === "beat" && fold(x.parent) === fold(p.value);
        return false;
      };
      return current.filter((x) => !gone(x));
    });
  }

  function add(p: Pick) {
    setPicked((current) => (current.some((x) => same(x, p)) ? current : [...current, p]));
  }

  const stateNode = (name: string) => places.states.find((s) => fold(s.state) === fold(name));

  const pickedStates = picked
    .filter((p) => p.kind === "state")
    .map((p) => stateNode(p.value) ?? { state: p.value, districts: [], shops: 0, undistricted: 0 });

  const districtsIn = (state: string) =>
    picked.filter((p) => p.kind === "district" && fold(p.parent) === fold(state));

  const townsIn = (district: string, state: string) =>
    picked.filter((p) => {
      if (p.kind !== "town") return false;
      const at = splitTownParent(p.parent);
      return fold(at.district) === fold(district) && fold(at.state) === fold(state);
    });

  /** Picks the tree no longer offers — a typed city or beat from before districts. */
  const earlierIn = (state: string) =>
    picked.filter(
      (p) =>
        (p.kind === "city" && fold(p.parent) === fold(state)) ||
        (p.kind === "beat" &&
          picked.some((c) => c.kind === "city" && fold(c.value) === fold(p.parent) && fold(c.parent) === fold(state))),
    );
  /* A typed city or beat that never named a state still counts — it is kept
     and listed, it just cannot be drawn under one. */
  const earlierNowhere = picked.filter(
    (p) =>
      (p.kind === "city" && !p.parent.trim()) ||
      (p.kind === "beat" && !picked.some((c) => c.kind === "city" && fold(c.value) === fold(p.parent))),
  );

  const districtNode = (state: StateNode, district: string) =>
    state.districts.find((d) => fold(d.district) === fold(district));

  /**
   * HOW MANY SHOPS THESE PLACES HOLD, which is the only number that tells
   * somebody whether they have allocated what they meant to. "Maharashtra,
   * Thane" reads like a narrowing either way; 2,352 shops and 739 do not. An
   * earlier typed pick has no count on the tree, so it is said rather than
   * guessed at.
   */
  let covered = 0;
  let uncounted = 0;
  for (const state of pickedStates) {
    const districts = districtsIn(state.state);
    const earlier = earlierIn(state.state).filter((p) => p.kind === "city");
    uncounted += earlier.length;
    if (!districts.length && !earlier.length) {
      covered += state.shops;
      continue;
    }
    for (const d of districts) {
      const node = districtNode(state, d.value);
      if (!node) continue;
      const towns = townsIn(d.value, state.state);
      covered += towns.length
        ? towns.reduce((sum, t) => sum + (node.towns.find((x) => fold(x.town) === fold(t.value))?.shops ?? 0), 0)
        : node.shops;
    }
  }
  uncounted += earlierNowhere.filter((p) => p.kind === "city").length;

  /** The sentence, in the shape somebody would say it out loud. */
  const summary = [
    ...pickedStates.map((state) => {
      const districts = districtsIn(state.state);
      const earlier = earlierIn(state.state).filter((p) => p.kind === "city");
      if (!districts.length && !earlier.length) return `the whole of ${state.state}`;
      const named = [
        ...districts.map((d) => {
          const towns = townsIn(d.value, state.state);
          return towns.length
            ? `${towns.map((t) => t.value).join(", ")} in ${d.value} district`
            : `${d.value} district`;
        }),
        ...earlier.map((c) => c.value),
      ];
      return `${named.join(", ")} in ${state.state}`;
    }),
    ...earlierNowhere.filter((p) => p.kind === "city").map((c) => c.value),
  ].join("; ");

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
  const several = pickedStates.length > 1;

  /* The districts on offer: every district of every picked state, biggest
     first within a state. The state is named on each only when more than one
     state is picked — with one, it is noise on every row. */
  const districtOptions = pickedStates.flatMap((s) =>
    s.districts.map((d) => ({
      value: districtKey(d.district, s.state),
      label: `${d.district}${several ? ` · ${s.state}` : ""} · ${count(d.shops)}`,
    })),
  );
  const pickedDistrictKeys = picked
    .filter((p) => p.kind === "district")
    .map((p) => districtKey(p.value, p.parent));

  function setStates(next: string[]) {
    const now = new Set(next.map(fold));
    for (const p of picked.filter((x) => x.kind === "state")) {
      if (!now.has(fold(p.value))) drop(p);
    }
    for (const value of next) add({ kind: "state", value, parent: "" });
  }

  function setDistricts(next: string[]) {
    const now = new Set(next);
    for (const p of picked.filter((x) => x.kind === "district")) {
      if (!now.has(districtKey(p.value, p.parent))) drop(p);
    }
    for (const key of next) {
      const at = key.indexOf("|");
      add(districtPick(key.slice(at + 1), key.slice(0, at)));
    }
  }

  /* Shops a picked district cannot reach, per state, said only where a
     district is narrowing that state — with the whole state picked they are
     reached anyway. */
  const unreachable = pickedStates.filter(
    (s) => s.undistricted > 0 && districtsIn(s.state).length > 0,
  );

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
                ? `About ${count(covered)} shops in these places${uncounted ? `, plus ${uncounted} earlier ${uncounted === 1 ? "pick" : "picks"}` : ""} · ${count(salesman.customerCount ?? 0)} in their book`
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
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <MultiSelect
                label="States"
                triggerLabel={pickedStates.length ? "Add states" : "Pick states"}
                everythingIsAll={false}
                options={places.states.map((s) => ({
                  value: s.state,
                  label: `${s.state} · ${count(s.shops)}`,
                }))}
                selected={pickedStates.map((s) => s.state)}
                onChange={setStates}
              />
              {pickedStates.map((s) => (
                <Chip
                  key={s.state}
                  label={s.state}
                  meta={count(s.shops)}
                  onRemove={() => drop({ kind: "state", value: s.state, parent: "" })}
                />
              ))}
            </div>

            <Step
              n={2}
              title="Narrow to districts, if you want to"
              hint="A state with no district picked means the whole state."
            />
            {pickedStates.length === 0 ? (
              <Empty>Pick a state above and its districts appear here.</Empty>
            ) : districtOptions.length === 0 ? (
              <p className="mt-2 text-[12px] text-muted">
                No shop in {pickedStates.map((s) => s.state).join(" or ")} is placed in a
                district yet, so the whole state is the only thing to allocate.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <MultiSelect
                  label="Districts"
                  triggerLabel={pickedDistrictKeys.length ? "Add districts" : "Pick districts"}
                  everythingIsAll={false}
                  options={districtOptions}
                  selected={pickedDistrictKeys}
                  onChange={setDistricts}
                />
                {picked
                  .filter((p) => p.kind === "district")
                  .map((d) => (
                    <Chip
                      key={districtKey(d.value, d.parent)}
                      label={several ? `${d.value} · ${d.parent}` : d.value}
                      onRemove={() => drop(d)}
                    />
                  ))}
              </div>
            )}

            <Step
              n={3}
              title="Narrow to towns, if you want to"
              hint="A district with nothing ticked under it means the whole district."
            />
            {pickedStates.every((s) => !districtsIn(s.state).length) ? (
              <Empty>Pick a district above and its towns appear here.</Empty>
            ) : (
              <div className="mt-2 flex flex-col gap-3">
                {pickedStates.flatMap((s) =>
                  districtsIn(s.state).map((d) => {
                    const node = districtNode(s, d.value);
                    return node ? (
                      <DistrictSection
                        key={districtKey(d.value, s.state)}
                        state={s.state}
                        district={node}
                        picked={townsIn(d.value, s.state)}
                        has={has}
                        add={add}
                        drop={drop}
                      />
                    ) : null;
                  }),
                )}
              </div>
            )}

            {unreachable.length ? (
              <p className="mt-3 text-[12px] text-pretty text-muted">
                {unreachable
                  .map((s) => `${count(s.undistricted)} shops in ${s.state}`)
                  .join(" and ")}{" "}
                are not placed in any district — the town on the record matched two places
                or none — so only a whole-state pick reaches them.
              </p>
            ) : null}

            {/* Earlier picks the tree no longer offers, kept and taken off one at a time. */}
            {pickedStates.some((s) => earlierIn(s.state).length) || earlierNowhere.length ? (
              <div className="mt-4 rounded-[4px] border border-line bg-canvas px-3 py-2.5">
                <p className="text-[12px] text-pretty text-muted">
                  Picked before districts existed. These go on meaning what they meant —
                  the town as the sheet typed it — until you take them off.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[...pickedStates.flatMap((s) => earlierIn(s.state)), ...earlierNowhere].map((p) => (
                    <Chip
                      key={`${p.kind}:${p.parent}:${p.value}`}
                      label={p.parent && p.kind === "city" ? `${p.value} · ${p.parent}` : p.value}
                      onRemove={() => drop(p)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

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
                  <span className="font-medium text-ink">{summary}</span>. The rest of their
                  book is still theirs; it is just not on the list.
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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 rounded-[4px] border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">
      {children}
    </p>
  );
}

/** One picked district, and the towns inside it. */
function DistrictSection({
  state,
  district,
  picked,
  has,
  add,
  drop,
}: {
  state: string;
  district: DistrictNode;
  picked: Pick[];
  has: (p: Pick) => boolean;
  add: (p: Pick) => void;
  drop: (p: Pick) => void;
}) {
  const [query, setQuery] = React.useState("");

  const towns = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return district.towns;
    return district.towns.filter((t) => t.town.toLowerCase().includes(q));
  }, [district.towns, query]);

  const whole = picked.length === 0;
  const parent = townParent(district.district, state);

  return (
    <section className="rounded-[4px] border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <span className="text-[13px] font-medium text-ink">
          {district.district} <span className="font-normal text-muted">· {state}</span>
        </span>
        <span className="text-[12px] text-muted">
          {whole ? (
            <Pill tone="brand">Whole district · {count(district.shops)} shops</Pill>
          ) : (
            <Pill>
              {picked.length} of {district.towns.length} towns
            </Pill>
          )}
        </span>
      </header>

      <div className="p-3">
        {district.towns.length === 0 ? (
          <p className="text-[12px] text-muted">
            No shop in {district.district} is placed in a town, so the whole district is the
            only thing to allocate.
          </p>
        ) : (
          <>
            {district.towns.length > SEARCH_ABOVE ? (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${count(district.towns.length)} towns in ${district.district}`}
                className="mb-2 h-8 w-full rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
              />
            ) : null}

            <div className="grid max-h-56 grid-cols-2 gap-x-3 gap-y-0.5 overflow-y-auto sm:grid-cols-3">
              {towns.length === 0 ? (
                <p className="col-span-full py-2 text-[12px] text-muted">
                  Nothing in {district.district} matches “{query}”.
                </p>
              ) : (
                towns.map((t) => {
                  const pick: Pick = { kind: "town", value: t.town, parent };
                  const on = has(pick);
                  return (
                    <label
                      key={t.town}
                      className="flex cursor-pointer items-start gap-2 rounded-[4px] px-1.5 py-1 hover:bg-canvas"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => (on ? drop(pick) : add(pick))}
                        className="mt-[3px] size-3.5 shrink-0 accent-[#5223E0]"
                      />
                      <span className="min-w-0 flex-1 text-[13px] text-pretty text-body">
                        {t.town}
                      </span>
                      <span className="shrink-0 text-[12px] text-muted">{count(t.shops)}</span>
                    </label>
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

/** A picked place, said back with a way to take it off. */
function Chip({ label, meta, onRemove }: { label: string; meta?: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-[4px] border border-brand bg-brand-soft pr-1 pl-2.5 text-[13px] font-medium text-[#5223E0]">
      <span className="truncate">{label}</span>
      {meta ? <span className="text-[#5223E0]/70">{meta}</span> : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Take off ${label}`}
        title={`Take off ${label}`}
        className="flex size-6 items-center justify-center rounded-[3px] text-[#5223E0]/70 hover:bg-[#5223E0]/10 hover:text-[#5223E0]"
      >
        ×
      </button>
    </span>
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
  return (
    <>
      {list.map(territoryName).join(", ")}
      <AreaAnswer salesman={salesman} />
    </>
  );
}

/**
 * What he said about these areas on his handset.
 *
 * An acceptance only counts for the allocation he was shown — the signature
 * is compared with the allocation as it stands now, and a stale one says so
 * rather than reading as a yes to cities he never saw.
 */
function AreaAnswer({ salesman }: { salesman: Salesman }) {
  const a = salesman.areaAnswer;
  if (!a) {
    return <span className="block text-xs text-muted">Not yet accepted on the handset</span>;
  }
  const on = new Date(a.at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: APP_TIMEZONE,
  });
  if (a.kind === "accept") {
    const current = a.signature === areasSignature(salesman.territories ?? []);
    return current ? (
      <span className="block text-xs text-success">Accepted on {on}</span>
    ) : (
      <span className="block text-xs text-muted" title="The areas have changed since he accepted them">
        Accepted an earlier allocation on {on}
      </span>
    );
  }
  const verdict =
    a.state === "approved" ? "approved" : a.state === "rejected" ? "declined" : "waiting on Approvals";
  return (
    <span className="block text-xs text-warn-ink" title={a.reason ?? undefined}>
      Asked for {a.requested.join(", ")} on {on} · {verdict}
    </span>
  );
}
