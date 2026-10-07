"use client";

import { useRouter } from "next/navigation";
import { money } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { NOBODY, TERRITORY_SEATS, type TerritorySeat } from "@/lib/territory-seats";
import type { TerritoryPerson } from "@/lib/services/sales-service";

function href(seat: TerritorySeat, person: string | null) {
  const q = new URLSearchParams({ seat });
  if (person) q.set("person", person);
  return `/sales/territory?${q.toString()}`;
}

/**
 * Which seat the territory is read through, and whose part of it.
 *
 * Changing the seat clears the person: somebody's id under "Back-office
 * account manager" means nothing under "Sales manager".
 */
export function TerritoryFilters({
  seat,
  person,
  people,
}: {
  seat: TerritorySeat;
  person: string | null;
  people: TerritoryPerson[];
}) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex h-8 items-stretch rounded-[4px] border border-line bg-surface p-0.5">
        {TERRITORY_SEATS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => router.push(href(s.key, null))}
            aria-pressed={seat === s.key}
            className={cx(
              "rounded-[3px] px-3 text-[13px] whitespace-nowrap",
              seat === s.key ? "bg-brand-soft font-medium text-[#5223E0]" : "text-body hover:bg-canvas",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <select
        value={person ?? ""}
        onChange={(e) => router.push(href(seat, e.target.value || null))}
        className="h-8 max-w-[240px] rounded-[4px] border border-line bg-surface px-2 text-[13px] text-ink"
        aria-label="Person"
      >
        <option value="">Everybody</option>
        <option value={NOBODY}>Nobody assigned</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Everybody in the chosen seat, with the book they hold. A row narrows the
 * map to that person; pressing it again goes back to everybody.
 */
export function PeopleList({
  seat,
  person,
  people,
  height,
}: {
  seat: TerritorySeat;
  person: string | null;
  people: TerritoryPerson[];
  height: number;
}) {
  const router = useRouter();
  return (
    <section
      className="flex flex-col overflow-hidden rounded-[6px] border border-line bg-surface"
      style={{ height }}
    >
      <header className="flex flex-none items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-[14px] font-semibold text-ink">People</span>
        <span className="text-[12px] text-muted">{people.length}</span>
      </header>
      {people.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13px] text-muted">Nobody holds this seat.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {people.map((p) => {
            const on = person === p.id;
            const empty = p.customers + p.leads === 0;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => router.push(href(seat, on ? null : p.id))}
                  className={cx(
                    "flex w-full items-start gap-3 border-b border-divider border-l-[3px] px-3.5 py-2.5 text-left",
                    on ? "border-l-brand bg-brand-soft" : "border-l-transparent hover:bg-canvas",
                  )}
                >
                  <span
                    className={cx(
                      "mt-0.5 flex size-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold",
                      empty ? "bg-divider text-muted" : "bg-brand-soft text-[#5223E0]",
                    )}
                  >
                    {p.initials}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">{p.name}</span>
                      <span className="flex-none text-[12px] text-muted tabular-nums">
                        {empty ? (
                          <span className="text-warn-ink">No book</span>
                        ) : (
                          `${p.customers} ${p.customers === 1 ? "customer" : "customers"}${
                            p.leads ? ` · ${p.leads} ${p.leads === 1 ? "lead" : "leads"}` : ""
                          }`
                        )}
                      </span>
                    </span>
                    {empty ? null : (
                      <>
                        <span className="block truncate text-[12px] text-muted" title={p.topCities.join(" · ")}>
                          {p.cityCount} {p.cityCount === 1 ? "city" : "cities"}
                          {p.topCities.length ? ` · ${p.topCities.slice(0, 3).join(", ")}` : ""}
                        </span>
                        <span className="block text-[11px] text-muted tabular-nums">
                          {p.outstandingPaise ? `${money(p.outstandingPaise)} outstanding` : "Nothing outstanding"}
                          {p.unpinned ? (
                            <span className="text-warn-ink"> · {p.unpinned} without a pin</span>
                          ) : null}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
