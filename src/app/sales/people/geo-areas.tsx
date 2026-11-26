"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { MultiSelect } from "@/components/ui/multi-select";
import { setSalesmanGeoTerritories } from "@/lib/actions/sales";
import {
  applyUlbPick,
  districtsIn,
  indexGeo,
  statesOf,
  subdistrictsIn,
  ulbsInSubdistrict,
  unmappedUlbsIn,
  type GeoAllocation,
  type GeoData,
  type GeoIndex,
  type GeoPick,
  type GeoUlb,
  REVIEW_FLAG_LABEL,
  cityOptions,
  restoreVia,
  ulbChipLabel,
  unplacedUlbsIn,
} from "@/lib/geography/geo-picker";
import { Button, Pill } from "@/components/console/parts";
import { ulbTypeName } from "@/lib/geography/lgd-ulb-types";

/**
 * THE OFFICIAL AREAS, beneath the dialog's existing steps: state, district,
 * taluka, then the cities and towns — urban local bodies — of the ticked talukas.
 *
 * It is drawn in THE DIALOG'S OWN LANGUAGE, because the steps above are the design
 * and this is their continuation: numbered steps, "Add …" pickers with purple chips
 * for the three wider levels, and — for the last one — a card per place with a pill
 * saying what it covers and a checkbox grid inside it, exactly as a picked district
 * lists its towns above. The Step, Chip and Empty below are the same markup as the
 * ones in `territories.tsx`, copied rather than imported because that file imports
 * this one.
 *
 * It is its OWN section with its OWN Save, and it narrows nothing: no shop list, no
 * handset book. It is what a manager proposes journey days from.
 *
 * WHAT IS OFFERED COMES FROM THE MASTER, so a place with no shop in it is still
 * there — which is why a city carries no shop count: the master has none to give.
 * "Cities and towns" is the source's urban local bodies and nothing more. A ULB the
 * source links to several talukas is listed in each of their cards and is ONE
 * allocation; one the source ties to a district and to no taluka is listed apart,
 * in a card of its own under the district, with dashed chips saying so.
 *
 * Ticking a taluka NARROWS to it, as ticking a district does above: a taluka with
 * nothing ticked beneath it is the whole taluka.
 */

/** Where a list stops being scannable and needs a search box — the dialog's own number. */
const SEARCH_ABOVE = 12;

type Ticks = { states: Set<string>; districts: Set<string>; subs: Set<string>; ulbs: Map<string, string | undefined> };

/** The ticks that would produce what was saved — one taluka per saved ULB, so re-saving never widens it. */
function ticksFrom(ix: GeoIndex, saved: GeoAllocation[]): Ticks {
  const t: Ticks = { states: new Set(), districts: new Set(), subs: new Set(), ulbs: new Map() };
  const tickUp = (id: string | null | undefined) => {
    for (let u = id ? ix.unit.get(id) : undefined; u; u = u.parentId ? ix.unit.get(u.parentId) : undefined) {
      (u.level === "state" ? t.states : u.level === "district" ? t.districts : t.subs).add(u.id);
    }
  };
  const savedUnits = new Set(saved.flatMap((a) => (a.unitId ? [a.unitId] : [])));
  for (const a of saved) if (a.unitId) tickUp(a.unitId);
  for (const a of saved) {
    if (!a.ulbId) continue;
    // Which place it was ticked under is chosen so that a re-save cannot drop a unit saved beside it.
    const via = restoreVia(ix, a.ulbId, savedUnits);
    tickUp(via);
    t.ulbs.set(a.ulbId, via);
  }
  return t;
}

/** Drop what no longer hangs from anything ticked above it. */
function reconcile(ix: GeoIndex, t: Ticks): Ticks {
  const districts = new Set([...t.districts].filter((d) => t.states.has(ix.unit.get(d)?.parentId ?? "")));
  const subs = new Set([...t.subs].filter((s) => districts.has(ix.unit.get(s)?.parentId ?? "")));
  const ulbs = new Map<string, string | undefined>();
  for (const [id, via] of t.ulbs) {
    const inTicked = (ix.subsByUlb.get(id) ?? []).filter((s) => subs.has(s));
    if (inTicked.length) {
      ulbs.set(id, via && inTicked.includes(via) ? via : inTicked[0]);
      continue;
    }
    // Ticked in the cities dropdown: it stays while a district it is linked to is ticked.
    const linked = [...districts].filter((dd) => (ix.ulbsByDistrict.get(dd) ?? []).some((u) => u.id === id));
    if (linked.length) ulbs.set(id, via && linked.includes(via) ? via : linked[0]);
    else if (!ix.placed.has(id) && t.states.has(ix.ulb.get(id)?.stateUnitId ?? "")) ulbs.set(id, ix.ulb.get(id)!.stateUnitId);
  }
  return { states: t.states, districts, subs, ulbs };
}

/** The numbered step heading — the same markup as the dialog's own. */
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

/** A picked place, said back with a way to take it off — the dialog's own chip. A city in no taluka is dashed. */
function Chip({ label, onRemove, unmapped = false }: { label: string; onRemove: () => void; unmapped?: boolean }) {
  return (
    <span
      title={unmapped ? "In the district, in no taluka — the source does not place it in one." : undefined}
      className={
        "inline-flex h-8 max-w-full items-center gap-1.5 rounded-[4px] border bg-brand-soft pr-1 pl-2.5 text-[13px] font-medium text-brand-hover " +
        (unmapped ? "border-dashed border-brand" : "border-brand")
      }
    >
      <span className="truncate">{label}</span>
      {unmapped ? <span className="text-[12px] font-normal text-brand-hover/70">no taluka</span> : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Take off ${label}`}
        title={`Take off ${label}`}
        className="flex size-6 items-center justify-center rounded-[3px] text-brand-hover/70 hover:bg-[#5223E0]/10 hover:text-brand-hover"
      >
        ×
      </button>
    </span>
  );
}

/**
 * One card of cities and towns — a ticked taluka's, or a district's "not mapped" ones.
 * The card of a picked district above is the model: a header naming the place with a
 * pill for what it covers, then a search box when the list is long and a checkbox grid.
 */
function UlbCard({
  title,
  place,
  pill,
  ulbs,
  ticked,
  onToggle,
  linkedIn,
  emptyText,
  chips,
  flagsOf,
}: {
  title: string;
  place: string;
  pill: React.ReactNode;
  ulbs: GeoUlb[];
  ticked: (id: string) => boolean;
  onToggle: (ulb: GeoUlb) => void;
  /** How many talukas the source links a ULB to — said beside it when more than one. */
  linkedIn?: (id: string) => number;
  emptyText: string;
  chips?: React.ReactNode;
  /** Review flags the source file carried for a ULB — drawn beside it, never hidden. */
  flagsOf?: (id: string) => Array<keyof typeof REVIEW_FLAG_LABEL>;
}) {
  const [query, setQuery] = React.useState("");
  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? ulbs.filter((u) => u.name.toLowerCase().includes(q)) : ulbs;
  }, [ulbs, query]);

  return (
    <section className="rounded-[4px] border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <span className="text-[13px] font-medium text-ink">
          {title} <span className="font-normal text-muted">· {place}</span>
        </span>
        <span className="text-[12px] text-muted">{pill}</span>
      </header>

      <div className="p-3">
        {chips ? <div className="mb-2 flex flex-wrap items-center gap-1.5">{chips}</div> : null}
        {ulbs.length === 0 ? (
          <p className="text-[12px] text-muted">{emptyText}</p>
        ) : (
          <>
            {ulbs.length > SEARCH_ABOVE ? (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${ulbs.length.toLocaleString("en-IN")} cities and towns in ${title}`}
                className="mb-2 h-8 w-full rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
              />
            ) : null}
            <div className="grid max-h-56 grid-cols-2 gap-x-3 gap-y-0.5 overflow-y-auto sm:grid-cols-3">
              {shown.length === 0 ? (
                <p className="col-span-full py-2 text-[12px] text-muted">Nothing in {title} matches “{query}”.</p>
              ) : (
                shown.map((u) => {
                  const on = ticked(u.id);
                  const several = linkedIn ? linkedIn(u.id) : 1;
                  return (
                    <label key={u.id} className="flex cursor-pointer items-start gap-2 rounded-[4px] px-1.5 py-1 hover:bg-canvas">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => onToggle(u)}
                        className="mt-[3px] size-3.5 shrink-0 accent-[#5223E0]"
                      />
                      <span className="min-w-0 flex-1 text-[13px] text-pretty text-body">
                        {u.name}
                        {(u.typeName ?? ulbTypeName(u.typeCode)) ? (
                          <span className="block text-[11px] font-normal text-muted">{u.typeName ?? ulbTypeName(u.typeCode)}</span>
                        ) : null}
                      </span>
                      {several > 1 ? <span className="shrink-0 text-[12px] text-muted">{several} talukas</span> : null}
                      {(flagsOf ? flagsOf(u.id) : []).map((f) => (
                        <span
                          key={f}
                          title={REVIEW_FLAG_LABEL[f].long}
                          data-review-flag={f}
                          className="shrink-0 rounded-[3px] border border-[#D9A441] bg-[#FFF6E0] px-1.5 text-[11px] font-medium text-[#7A5200]"
                        >
                          {REVIEW_FLAG_LABEL[f].short}
                        </span>
                      ))}
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

/** The master, fetched once per page visit and only when somebody opens the dialog. */
let geoRequest: Promise<GeoData | null> | null = null;
function fetchGeoMaster(): Promise<GeoData | null> {
  geoRequest ??= fetch("/api/sales/geo-master", { credentials: "same-origin" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`geo master ${r.status}`);
      return ((await r.json()) as { geo: GeoData | null }).geo;
    })
    .catch((e) => {
      geoRequest = null; // a failure is not remembered: the next try asks again
      throw e;
    });
  return geoRequest;
}

type MasterState = { status: "loading" } | { status: "ready"; geo: GeoData | null } | { status: "error" };

export function GeoAreas({
  salesmanId,
  salesmanName,
  available,
  saved,
}: {
  salesmanId: string;
  salesmanName: string;
  /** Whether a master has been loaded at all — decided by the page, which does not carry the master. */
  available: boolean;
  saved: GeoAllocation[];
}) {
  const [state, setState] = React.useState<MasterState>({ status: "loading" });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!available) return;
    let alive = true;
    fetchGeoMaster().then(
      (geo) => alive && setState({ status: "ready", geo }),
      () => alive && setState({ status: "error" }),
    );
    return () => {
      alive = false;
    };
  }, [available, attempt]);

  const note = (body: React.ReactNode) => (
    <section className="mt-6 rounded-[4px] border border-line bg-canvas px-3 py-2.5 text-[12px] text-pretty text-muted">
      <p className="font-medium text-ink">Official areas — talukas and cities/towns</p>
      <p className="mt-1">{body}</p>
    </section>
  );

  /* A master that is genuinely empty, with nothing saved against it, draws
     nothing: a heading saying towns are not loaded, under a list of towns, only
     misleads. A failed load is not "empty" and still says so below. */
  const empty = !available || (state.status === "ready" && !state.geo);
  if (empty && !saved.length) return null;
  if (empty) {
    return note(
      "The official geography (states, districts, talukas and urban local bodies) has not been loaded yet, so there is nothing to pick here. Nothing above is affected.",
    );
  }
  if (state.status === "loading") return note("Loading the official areas…");
  if (state.status === "error") {
    return note(
      <>
        The official areas could not be loaded. Nothing above is affected.{" "}
        <button
          type="button"
          className="cursor-pointer text-brand underline"
          onClick={() => {
            setState({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </>,
    );
  }
  return <GeoAreasLoaded salesmanId={salesmanId} salesmanName={salesmanName} geo={state.geo!} saved={saved} />;
}

function GeoAreasLoaded({
  salesmanId,
  salesmanName,
  geo,
  saved,
}: {
  salesmanId: string;
  salesmanName: string;
  geo: GeoData;
  saved: GeoAllocation[];
}) {
  const router = useRouter();
  const toast = useToast();
  const ix = React.useMemo(() => indexGeo(geo), [geo]);
  const [ticks, setTicks] = React.useState<Ticks>(() => ticksFrom(ix, saved));
  const [busy, setBusy] = React.useState(false);

  const set = (next: Ticks) => setTicks(reconcile(ix, next));
  const name = (id: string) => ix.unit.get(id)?.name ?? id;
  const without = <T,>(s: Set<T>, v: T) => new Set([...s].filter((x) => x !== v));
  const districts = districtsIn(ix, ticks.states);
  const subs = subdistrictsIn(ix, ticks.districts);
  const severalStates = ticks.states.size > 1;
  const severalDistricts = ticks.districts.size > 1;
  const cities = cityOptions(ix, ticks);
  const cityScope = new Set(cities.map((c) => c.ulb.id));
  const viaOf = new Map(cities.map((c) => [c.ulb.id, c.viaId]));

  /* One tick of one city, wherever its checkbox is. It records the place it was ticked
     under (`via`), and only that city can change — `applyUlbPick` keeps every other tick. */
  const toggleUlb = (ulb: GeoUlb, via: string | undefined) => {
    const ids = ticks.ulbs.has(ulb.id) ? [...ticks.ulbs.keys()].filter((x) => x !== ulb.id) : [...ticks.ulbs.keys(), ulb.id];
    set({ ...ticks, ulbs: applyUlbPick(ticks.ulbs, ids, new Set([ulb.id]), () => via) });
  };

  const save = async () => {
    setBusy(true);
    const picks: GeoPick[] = [
      ...[...ticks.states, ...ticks.districts, ...ticks.subs].map((unitId) => ({ kind: "unit" as const, unitId })),
      ...[...ticks.ulbs].map(([ulbId, viaUnitId]) => ({ kind: "ulb" as const, ulbId, viaUnitId })),
    ];
    const r = await setSalesmanGeoTerritories({ salesmanId, picks });
    setBusy(false);
    if (r.ok) {
      toast.push(r.message ?? "Saved.");
      router.refresh();
    } else toast.push(r.error);
  };

  const selectedIn = (list: GeoUlb[]) => list.filter((u) => ticks.ulbs.has(u.id)).length;

  return (
    <section className="mt-8 border-t border-line pt-4">
      <p className="text-[13px] font-medium text-ink">Official areas — talukas and cities/towns</p>
      <p className="mt-1 text-[12px] text-pretty text-muted">
        From the official geography, so places with no shop in them are here too. This does not change which shops{" "}
        {salesmanName} sees — it is the list you propose journey days from. Cities and towns are the urban local bodies in
        the source, not every settlement.
      </p>

      <Step n={4} title="Pick the states they cover" />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <MultiSelect
          label="Official states"
          triggerLabel={ticks.states.size ? "Add states" : "Pick states"}
          everythingIsAll={false}
          options={statesOf(ix).map((s) => ({ value: s.id, label: s.name }))}
          selected={[...ticks.states]}
          onChange={(ids) => set({ ...ticks, states: new Set(ids) })}
        />
        {[...ticks.states].map((id) => (
          <Chip key={id} label={name(id)} onRemove={() => set({ ...ticks, states: without(ticks.states, id) })} />
        ))}
      </div>

      <Step n={5} title="Narrow to districts, if you want to" hint="A state with no district picked means the whole state." />
      {ticks.states.size === 0 ? (
        <Empty>Pick a state above and its districts appear here.</Empty>
      ) : districts.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted">The official list has no district for {[...ticks.states].map(name).join(" or ")}.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <MultiSelect
            label="Official districts"
            triggerLabel={ticks.districts.size ? "Add districts" : "Pick districts"}
            everythingIsAll={false}
            options={districts.map((d) => ({ value: d.id, label: severalStates ? `${d.name} · ${name(d.parentId ?? "")}` : d.name }))}
            selected={[...ticks.districts]}
            onChange={(ids) => set({ ...ticks, districts: new Set(ids) })}
          />
          {[...ticks.districts].map((id) => (
            <Chip
              key={id}
              label={severalStates ? `${name(id)} · ${name(ix.unit.get(id)?.parentId ?? "")}` : name(id)}
              onRemove={() => set({ ...ticks, districts: without(ticks.districts, id) })}
            />
          ))}
        </div>
      )}

      <Step
        n={6}
        title="Narrow to cities and towns, if you want to"
        hint="The cities and towns of the districts above. One in several districts is listed once."
      />
      {cities.length === 0 ? (
        <Empty>
          {ticks.districts.size === 0
            ? "Pick a district above and its cities and towns appear here."
            : "The official list has no city or town for the districts above."}
        </Empty>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <MultiSelect
            label="Cities and towns"
            triggerLabel={ticks.ulbs.size ? "Add cities and towns" : "Pick cities and towns"}
            everythingIsAll={false}
            options={cities.map((c) => ({
              value: c.ulb.id,
              label: c.ulb.name,
              sub: [c.ulb.typeName ?? ulbTypeName(c.ulb.typeCode), c.places.join(", ")].filter(Boolean).join(" · "),
              badges: (ix.flagsByUlb.get(c.ulb.id) ?? []).map((f) => ({ key: f, text: REVIEW_FLAG_LABEL[f].short, title: REVIEW_FLAG_LABEL[f].long })),
            }))}
            selected={cities.filter((c) => ticks.ulbs.has(c.ulb.id)).map((c) => c.ulb.id)}
            onChange={(ids) => set({ ...ticks, ulbs: applyUlbPick(ticks.ulbs, ids, cityScope, (id) => viaOf.get(id)) })}
          />
          {[...ticks.ulbs.keys()].map((id) => {
            const u = ix.ulb.get(id);
            if (!u) return null;
            return (
              <Chip
                key={id}
                label={ulbChipLabel(ix, id)}
                unmapped={!ix.placed.has(id)}
                onRemove={() => set({ ...ticks, ulbs: new Map([...ticks.ulbs].filter(([k]) => k !== id)) })}
              />
            );
          })}
        </div>
      )}

      <Step n={7} title="Narrow to talukas, if you want to" hint="A district with no taluka picked means the whole district." />
      {ticks.districts.size === 0 ? (
        <Empty>Pick a district above and its talukas and tehsils appear here.</Empty>
      ) : subs.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted">The official list has no taluka for {[...ticks.districts].map(name).join(" or ")}.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <MultiSelect
            label="Talukas and tehsils"
            triggerLabel={ticks.subs.size ? "Add talukas" : "Pick talukas"}
            everythingIsAll={false}
            options={subs.map((s) => ({ value: s.id, label: severalDistricts ? `${s.name} · ${name(s.parentId ?? "")}` : s.name }))}
            selected={[...ticks.subs]}
            onChange={(ids) => set({ ...ticks, subs: new Set(ids) })}
          />
          {[...ticks.subs].map((id) => (
            <Chip
              key={id}
              label={severalDistricts ? `${name(id)} · ${name(ix.unit.get(id)?.parentId ?? "")}` : name(id)}
              onRemove={() => set({ ...ticks, subs: without(ticks.subs, id) })}
            />
          ))}
        </div>
      )}

      <Step
        n={8}
        title="Cities and towns by taluka"
        hint="The same cities and towns, listed under their taluka. A taluka with nothing ticked under it means the whole taluka."
      />
      {ticks.subs.size === 0 && ticks.districts.size === 0 && unplacedUlbsIn(ix, ticks.states).length === 0 ? (
        <Empty>Pick a district above and its cities and towns appear here, by taluka.</Empty>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          {subs
            .filter((s) => ticks.subs.has(s.id))
            .map((s) => {
              const list = ulbsInSubdistrict(ix, s.id);
              const n = selectedIn(list);
              return (
                <UlbCard
                  key={s.id}
                  title={s.name}
                  place={name(s.parentId ?? "")}
                  pill={n === 0 ? <Pill tone="brand">Whole taluka</Pill> : <Pill>{n} of {list.length} cities</Pill>}
                  ulbs={list}
                  ticked={(id) => ticks.ulbs.has(id)}
                  onToggle={(u) => toggleUlb(u, s.id)}
                  linkedIn={(id) => (ix.subsByUlb.get(id) ?? []).length}
                  flagsOf={(id) => ix.flagsByUlb.get(id) ?? []}
                  emptyText={`No urban local body is linked to ${s.name}, so the whole taluka is the only thing to allocate.`}
                />
              );
            })}

          {/* The ones the source ties to a district and to no taluka: apart, never inside one. */}
          {[...ticks.districts].map((did) => {
            const list = unmappedUlbsIn(ix, [did]);
            if (!list.length) return null;
            const on = list.filter((u) => ticks.ulbs.has(u.id));
            return (
              <UlbCard
                key={`unmapped:${did}`}
                title="Not mapped to a taluka"
                place={name(did)}
                pill={<Pill>{on.length} of {list.length} cities</Pill>}
                ulbs={list}
                ticked={(id) => ticks.ulbs.has(id)}
                onToggle={(u) => toggleUlb(u, did)}
                emptyText=""
                flagsOf={(id) => ix.flagsByUlb.get(id) ?? []}
                chips={on.map((u) => (
                  <Chip key={u.id} label={ulbChipLabel(ix, u.id)} unmapped onRemove={() => toggleUlb(u, did)} />
                ))}
              />
            );
          })}

          {/* The ones the source could not place in ANY district: apart, per state, flagged "Unresolved". */}
          {[...ticks.states].map((sid) => {
            const list = unplacedUlbsIn(ix, [sid]);
            if (!list.length) return null;
            const on = list.filter((u) => ticks.ulbs.has(u.id));
            return (
              <UlbCard
                key={`unplaced:${sid}`}
                title="No district in the official list"
                place={name(sid)}
                pill={<Pill>{on.length} of {list.length} cities</Pill>}
                ulbs={list}
                ticked={(id) => ticks.ulbs.has(id)}
                onToggle={(u) => toggleUlb(u, sid)}
                emptyText=""
                flagsOf={(id) => ix.flagsByUlb.get(id) ?? []}
                chips={on.map((u) => (
                  <Chip key={u.id} label={ulbChipLabel(ix, u.id)} unmapped onRemove={() => toggleUlb(u, sid)} />
                ))}
              />
            );
          })}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <Button tone="primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save official areas"}
        </Button>
      </div>
    </section>
  );
}
