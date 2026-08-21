import Link from "next/link";
import { money } from "@/lib/format";
import { fieldTeam, gpsGap, territory } from "@/lib/services/sales-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";
import {
  plural,
} from "../words";

export const metadata = { title: "Territory — Sales Dashboard — MahekOne" };

/**
 * Which regions, cities and beats belong to whom.
 *
 * Grouped rather than listed. A territory screen answers "who covers Nagpur"
 * and "how much of the book has nobody", and a thousand customer rows answers
 * neither — the customer list is a click away on each salesman's own record.
 *
 * The GPS column is the one that costs something. Route optimisation, the
 * geofence check and the "were you actually there" verdict all read a
 * coordinate and all answer "cannot tell" without one — silently, and in the
 * safe direction, which is exactly why nobody notices. A count per beat is
 * what turns that into a decision somebody can take.
 */
export default async function Page() {
  const [rows, gap, team] = await Promise.all([territory(), gpsGap(), fieldTeam()]);

  const unassigned = rows.filter((r) => !r.salesmanId);
  const regions = new Set(rows.map((r) => r.region ?? "—"));
  const cities = new Set(rows.map((r) => r.city));
  const shops = rows.reduce((n, r) => n + r.shops, 0);

  /* Who covers what, because that is the question the screen is opened with. */
  const byPerson = new Map<string, { name: string; id: string; cities: Set<string>; shops: number }>();
  for (const r of rows) {
    if (!r.salesmanId) continue;
    const at = byPerson.get(r.salesmanId) ?? {
      name: r.salesmanName ?? "—",
      id: r.salesmanId,
      cities: new Set<string>(),
      shops: 0,
    };
    at.cities.add(r.city);
    at.shops += r.shops;
    byPerson.set(r.salesmanId, at);
  }
  const covering = team.filter((t) => t.active && !byPerson.has(t.id));

  return (
    <div className="p-6">
      <ScreenHeader
        title="Territory"
        subtitle="Which regions, cities and beats belong to whom. Whose book a shop is in decides who is credited for its orders and whose figures it counts toward, so this is the map behind every other number in the console."
      />

      {gap.missing > 0 ? (
        <Banner
          tone="warn"
          title={`${gap.missing} of ${gap.total} shops have no coordinates`}
          body="Route optimisation appends them to the end of a plan rather than dropping them, and a visit to one is recorded as “cannot tell” rather than as a mismatch — so nothing breaks loudly. Every visit is an opportunity to capture one."
        />
      ) : null}

      {covering.length ? (
        <Banner
          tone="warn"
          title={`${plural(covering.length, "salesman", "salesmen")} ${covering.length === 1 ? "covers" : "cover"} nothing`}
          body={`${covering.map((c) => c.name).join(", ")} — no shop names them as its sales account manager, so their handset opens on an empty book.`}
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Shops", value: String(shops) },
          { label: "Cities", value: String(cities.size) },
          { label: "Regions", value: String(regions.size) },
          {
            label: "In nobody's book",
            value: String(unassigned.reduce((n, r) => n + r.shops, 0)),
            tone: unassigned.length ? "warn" : undefined,
          },
          {
            label: "Without a pin",
            value: String(gap.missing),
            tone: gap.missing ? "warn" : undefined,
          },
        ]}
      />

      {byPerson.size ? (
        <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
          <div className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Who covers what
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {[...byPerson.values()].map((p) => (
              <span key={p.id} className="block">
                <Link
                  href={`/sales/people/${p.id}`}
                  className="block text-[13px] font-medium text-ink no-underline hover:underline"
                >
                  {p.name}
                </Link>
                <span className="block text-lg font-semibold text-ink tabular-nums">
                  {p.shops}
                </span>
                <span className="block text-[12px] text-muted">
                  {[...p.cities].slice(0, 3).join(", ")}
                  {p.cities.size > 3 ? ` +${p.cities.size - 3}` : ""}
                </span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <Empty
          title="No territory to show"
          body="A territory is built from the customer records — their region, city and beat, and whose book they are in. Nothing has been imported or assigned yet."
        />
      ) : (
        <Table
          minWidth={1080}
          head={
            <>
              <HeadCell width={180}>Region</HeadCell>
              <HeadCell width={200}>City</HeadCell>
              <HeadCell width={220}>Beat</HeadCell>
              <HeadCell width={190}>Salesman</HeadCell>
              <HeadCell align="right" width={100}>Shops</HeadCell>
              <HeadCell width={140}>Pins</HeadCell>
              <HeadCell align="right" width={150}>Owing</HeadCell>
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={`${r.region}:${r.city}:${r.beat}:${r.salesmanId}`} striped={i % 2 === 1}>
              <Cell truncate={180}>
                {r.region ?? <span className="text-muted">Not set</span>}
              </Cell>
              <Cell truncate={200}>{r.city}</Cell>
              <Cell truncate={220}>
                {r.beat ?? <span className="text-muted">No beat</span>}
              </Cell>
              <Cell truncate={190}>
                {r.salesmanId ? (
                  <Link
                    href={`/sales/people/${r.salesmanId}`}
                    className="no-underline hover:underline"
                  >
                    {r.salesmanName}
                  </Link>
                ) : (
                  <span className="text-warn-ink">Nobody</span>
                )}
              </Cell>
              <Cell align="right">{r.shops}</Cell>
              <Cell>
                {r.withGps === r.shops ? (
                  <Pill tone="success">All</Pill>
                ) : r.withGps === 0 ? (
                  <Pill tone="warn">None</Pill>
                ) : (
                  <span className="text-[13px] tabular-nums">
                    {r.withGps} of {r.shops}
                  </span>
                )}
              </Cell>
              <Cell align="right">
                {Number(r.outstandingPaise) ? (
                  money(r.outstandingPaise)
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}
