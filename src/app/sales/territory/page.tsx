import Link from "next/link";
import {
  prospectPins,
  shopPins,
  territorySeatPeople,
  territoryTotals,
} from "@/lib/services/sales-service";
import { liveOlaKey } from "@/lib/services/ola-key-service";
import { MetricRow } from "@/components/console/parts";
import { NOBODY, parseSeat, seatLabel } from "@/lib/territory-seats";
import { ShopMap } from "./shop-map";
import { PeopleList, TerritoryFilters } from "./territory-controls";

export const metadata = { title: "Territory — Sales Dashboard — MahekOne" };

const MAP_HEIGHT = 600;

/**
 * Where the book sits, read through one of the four seats an account carries
 * — field sales, sales account manager, back-office account manager or sales
 * manager — and narrowed to one person in it, or to the accounts nobody holds.
 *
 * Three things on the screen: the figures, the map, and the people in the
 * seat. Picking a person narrows the first two; the list stays whole so the
 * next person is one click away. Everything the old screen said in banners is
 * a figure or a mark on a row now — "covers nothing" is "No book" on that
 * person, and "without coordinates" is a figure with a count against each
 * person who holds one.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ seat?: string; person?: string }>;
}) {
  const params = await searchParams;
  const seat = parseSeat(params.seat);

  const [people, olaMaps] = await Promise.all([territorySeatPeople(seat), liveOlaKey()]);
  /* Only somebody actually in this seat, or "nobody" — any other id is a stale
     link and reads as everybody rather than as an empty map. */
  const person =
    params.person === NOBODY || people.some((p) => p.id === params.person) ? params.person! : null;
  const chosen = people.find((p) => p.id === person) ?? null;

  const [totals, shops, prospects] = await Promise.all([
    territoryTotals(seat, person),
    shopPins({ seat: { seat, person } }),
    /* A prospect pin belongs to nobody's book, so it is drawn only on the
       whole map, never against one person. */
    person ? Promise.resolve([]) : prospectPins(),
  ]);

  const who = chosen ? chosen.name : person === NOBODY ? `No ${seatLabel(seat).toLowerCase()}` : null;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-2xl leading-[30px] font-semibold text-ink">Territory</h1>
          {who ? (
            <span className="truncate text-[15px] text-muted">
              {who} ·{" "}
              <Link href={`/sales/territory?seat=${seat}`} className="text-[13px]">
                Clear
              </Link>
            </span>
          ) : null}
        </div>
        <TerritoryFilters seat={seat} person={person} people={people} />
      </div>

      <MetricRow
        metrics={[
          { label: "Customers", value: totals.customers.toLocaleString("en-IN") },
          { label: "Leads", value: totals.leads.toLocaleString("en-IN") },
          { label: "Cities", value: totals.cities.toLocaleString("en-IN") },
          {
            label: "Without a pin",
            value: totals.unpinned.toLocaleString("en-IN"),
            tone: totals.unpinned ? "warn" : undefined,
          },
          ...(person
            ? []
            : [
                {
                  label: `No ${seatLabel(seat).toLowerCase()}`,
                  value: totals.unassigned.toLocaleString("en-IN"),
                  tone: totals.unassigned ? ("warn" as const) : undefined,
                },
              ]),
        ]}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-4">
        <ShopMap
          key={`${seat}:${person ?? ""}`}
          shops={shops}
          prospects={prospects}
          apiKey={olaMaps.key}
          keysSpent={olaMaps.allSpent}
          height={MAP_HEIGHT}
        />
        <PeopleList seat={seat} person={person} people={people} height={MAP_HEIGHT} />
      </div>
    </div>
  );
}
