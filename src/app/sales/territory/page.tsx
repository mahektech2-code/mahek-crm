import {
  prospectPins,
  shopPins,
  territoryCities,
  territorySeatPeople,
  territoryTotals,
} from "@/lib/services/sales-service";
import { liveOlaKey } from "@/lib/services/ola-key-service";
import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { NOBODY, parseSeat, seatLabel } from "@/lib/territory-seats";
import { ShopMap } from "./shop-map";
import {
  CitiesTable,
  PeopleTable,
  TerritoryFilters,
  TerritoryTabs,
  type TerritoryView,
} from "./territory-controls";

export const metadata = { title: "Territory — Sales Dashboard — MahekOne" };

/**
 * Where the book sits, read through one of the four seats an account carries
 * — field sales, sales account manager, back-office account manager or sales
 * manager — and narrowed to one person in it, or to the accounts nobody holds.
 *
 * A filter card, five figures, then three tabs: People (who holds what),
 * Cities (who covers each place) and Map. Everything the old screen said in
 * banners is a figure or a mark on a row now — "covers nothing" is "No book"
 * on that person, "without coordinates" is the No pin column.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ seat?: string; person?: string; view?: string }>;
}) {
  const params = await searchParams;
  const seat = parseSeat(params.seat);
  const view: TerritoryView =
    params.view === "cities" || params.view === "map" ? params.view : "people";

  const people = await territorySeatPeople(seat);
  /* Only somebody actually in this seat, or "nobody" — any other id is a stale
     link and reads as everybody rather than as an empty screen. */
  const person =
    params.person === NOBODY || people.some((p) => p.id === params.person) ? params.person! : null;
  const chosen = people.find((p) => p.id === person) ?? null;

  const [totals, cities, mapData] = await Promise.all([
    territoryTotals(seat, person),
    territoryCities(seat, person),
    view === "map"
      ? Promise.all([
          shopPins({ seat: { seat, person } }),
          /* A prospect pin is nobody's book, so it is drawn only on the whole map. */
          person ? Promise.resolve([]) : prospectPins(),
          liveOlaKey(),
        ])
      : null,
  ]);

  const role = seatLabel(seat);
  const scopeLine = chosen
    ? `${chosen.name} · ${role}`
    : person === NOBODY
      ? `Accounts with no ${role.toLowerCase()}`
      : `Whole book · by ${role.toLowerCase()}`;

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="text-2xl leading-[30px] font-semibold text-ink">Territory</h1>
        <p className="mt-0.5 text-[13px] text-muted">{scopeLine}</p>
      </div>

      <TerritoryFilters seat={seat} person={person} view={view} people={people} />

      <CardGrid min={160} gap="gap-3">
        <Tile label="Customers" value={totals.customers} />
        <Tile label="Leads" value={totals.leads} />
        <Tile label="Cities" value={totals.cities} />
        <Tile label="Without a pin" value={totals.unpinned} warn />
        {person ? null : <Tile label={`No ${role.toLowerCase()}`} value={totals.unassigned} warn />}
      </CardGrid>

      <div className="space-y-4">
        <TerritoryTabs
          seat={seat}
          person={person}
          view={view}
          counts={{ people: people.length, cities: cities.length }}
        />
        {view === "people" ? (
          <PeopleTable seat={seat} person={person} people={people} />
        ) : view === "cities" ? (
          <CitiesTable cities={cities} seatName={role} />
        ) : mapData ? (
          <ShopMap
            key={`${seat}:${person ?? ""}`}
            shops={mapData[0]}
            prospects={mapData[1]}
            apiKey={mapData[2].key}
            keysSpent={mapData[2].allSpent}
          />
        ) : null}
      </div>
    </div>
  );
}

/** One figure. Amber only where there is something to fix. */
function Tile({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-4 py-3.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div
        className={cx(
          "mt-1 text-[24px] leading-7 font-semibold tabular-nums",
          warn && value > 0 ? "text-warn-ink" : "text-ink",
        )}
      >
        {value.toLocaleString("en-IN")}
      </div>
    </div>
  );
}
