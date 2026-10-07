"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { Cell, HeadCell, Row, Table } from "@/components/console/parts";
import { NOBODY, TERRITORY_SEATS, type TerritorySeat } from "@/lib/territory-seats";
import type { TerritoryCity, TerritoryPerson } from "@/lib/services/sales-service";

export type TerritoryView = "people" | "cities" | "map";

export function territoryHref(seat: TerritorySeat, person: string | null, view: TerritoryView) {
  const q = new URLSearchParams({ seat });
  if (person) q.set("person", person);
  if (view !== "people") q.set("view", view);
  return `/sales/territory?${q.toString()}`;
}

/**
 * Which seat the territory is read through, and whose part of it.
 *
 * Changing the seat clears the person: somebody's id under "Back-office
 * account manager" means nothing under "Sales manager". The tab is kept.
 */
export function TerritoryFilters({
  seat,
  person,
  view,
  people,
}: {
  seat: TerritorySeat;
  person: string | null;
  view: TerritoryView;
  people: TerritoryPerson[];
}) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Role</span>
        <select
          value={seat}
          onChange={(e) => router.push(territoryHref(e.target.value as TerritorySeat, null, view))}
          className="h-9 w-[240px] rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink"
        >
          {TERRITORY_SEATS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Person</span>
        <select
          value={person ?? ""}
          onChange={(e) => router.push(territoryHref(seat, e.target.value || null, view))}
          className="h-9 w-[240px] rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink"
        >
          <option value="">Everybody ({people.length})</option>
          <option value={NOBODY}>Nobody assigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {person ? (
        <Link
          href={territoryHref(seat, null, view)}
          className="inline-flex h-9 items-center rounded-[4px] px-2 text-[13px]"
        >
          Clear
        </Link>
      ) : null}
    </div>
  );
}

/** People · Cities · Map — links, so each one bookmarks. */
export function TerritoryTabs({
  seat,
  person,
  view,
  counts,
}: {
  seat: TerritorySeat;
  person: string | null;
  view: TerritoryView;
  counts: { people: number; cities: number };
}) {
  const tabs: Array<{ key: TerritoryView; label: string; count?: number }> = [
    { key: "people", label: "People", count: counts.people },
    { key: "cities", label: "Cities", count: counts.cities },
    { key: "map", label: "Map" },
  ];
  return (
    <nav className="flex gap-6 border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={territoryHref(seat, person, t.key)}
          aria-current={view === t.key ? "page" : undefined}
          className={cx(
            "-mb-px border-b-2 pb-2.5 text-[14px] no-underline hover:no-underline",
            view === t.key
              ? "border-brand font-medium text-ink"
              : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count != null ? <span className="ml-1.5 text-[12px] text-muted tabular-nums">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Everybody in the chosen seat and the book they hold. A row narrows the whole
 * screen to that person; clicking it again goes back to everybody.
 */
export function PeopleTable({
  seat,
  person,
  people,
}: {
  seat: TerritorySeat;
  person: string | null;
  people: TerritoryPerson[];
}) {
  const router = useRouter();
  if (people.length === 0) {
    return <Empty>Nobody holds this role yet.</Empty>;
  }
  return (
    <Table
      minWidth={940}
      head={
        <>
          <HeadCell width={220}>Name</HeadCell>
          <HeadCell align="right" width={100}>
            Customers
          </HeadCell>
          <HeadCell align="right" width={80}>
            Leads
          </HeadCell>
          <HeadCell align="right" width={80}>
            Cities
          </HeadCell>
          <HeadCell width={230}>Main cities</HeadCell>
          <HeadCell align="right" width={130}>
            Outstanding
          </HeadCell>
          <HeadCell align="right" width={100}>
            No pin
          </HeadCell>
        </>
      }
    >
      {people.map((p, i) => {
        const empty = p.customers + p.leads === 0;
        return (
          <Row
            key={p.id}
            striped={i % 2 === 1}
            selected={person === p.id}
            onClick={() => router.push(territoryHref(seat, person === p.id ? null : p.id, "people"))}
          >
            <Cell>
              <span className="flex items-center gap-2.5">
                <span
                  className={cx(
                    "flex size-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold",
                    empty ? "bg-divider text-muted" : "bg-brand-soft text-[#5223E0]",
                  )}
                >
                  {p.initials}
                </span>
                <span className="truncate font-medium text-ink">{p.name}</span>
              </span>
            </Cell>
            <Cell align="right">{empty ? <span className="text-warn-ink">No book</span> : p.customers}</Cell>
            <Cell align="right">{p.leads || <Dash />}</Cell>
            <Cell align="right">{p.cityCount || <Dash />}</Cell>
            <Cell title={p.topCities.join(" · ")}>
              <span className="block truncate text-muted">
                {p.topCities.length ? p.topCities.slice(0, 3).join(", ") : "—"}
              </span>
            </Cell>
            <Cell align="right">{p.outstandingPaise ? money(p.outstandingPaise) : <Dash />}</Cell>
            <Cell align="right">
              {p.unpinned ? <span className="text-warn-ink">{p.unpinned}</span> : <Dash />}
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

/** The same book cut by place: who covers each city, and how much of it is nobody's. */
export function CitiesTable({ cities, seatName }: { cities: TerritoryCity[]; seatName: string }) {
  if (cities.length === 0) {
    return <Empty>No accounts here.</Empty>;
  }
  return (
    <Table
      minWidth={940}
      head={
        <>
          <HeadCell width={190}>City</HeadCell>
          <HeadCell width={140}>Region</HeadCell>
          <HeadCell align="right" width={95}>
            Customers
          </HeadCell>
          <HeadCell align="right" width={70}>
            Leads
          </HeadCell>
          <HeadCell width={235}>{seatName}</HeadCell>
          <HeadCell align="right" width={130}>
            Outstanding
          </HeadCell>
          <HeadCell align="right" width={80}>
            No pin
          </HeadCell>
        </>
      }
    >
      {cities.map((c, i) => (
        <Row key={`${c.state}|${c.city}`} striped={i % 2 === 1}>
          <Cell>
            <span className="block truncate font-medium text-ink">{c.city ?? "No city"}</span>
          </Cell>
          <Cell>
            <span className="block truncate text-muted">{c.state ?? "—"}</span>
          </Cell>
          <Cell align="right">{c.customers || <Dash />}</Cell>
          <Cell align="right">{c.leads || <Dash />}</Cell>
          <Cell title={c.holders.join(", ")}>
            <span className="block truncate">
              {c.holders.length ? (
                c.holders.length > 2 ? (
                  `${c.holders.slice(0, 2).join(", ")} +${c.holders.length - 2}`
                ) : (
                  c.holders.join(", ")
                )
              ) : (
                <span className="text-warn-ink">Nobody</span>
              )}
              {c.holders.length && c.unassigned ? (
                <span className="text-warn-ink"> · {c.unassigned} unassigned</span>
              ) : null}
            </span>
          </Cell>
          <Cell align="right">{c.outstandingPaise ? money(c.outstandingPaise) : <Dash />}</Cell>
          <Cell align="right">
            {c.unpinned ? <span className="text-warn-ink">{c.unpinned}</span> : <Dash />}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function Dash() {
  return <span className="text-muted">—</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[6px] border border-line bg-surface px-5 py-12 text-center text-[13px] text-muted">
      {children}
    </p>
  );
}
