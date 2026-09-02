import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import {
  fieldTeam,
  gpsGap,
  prospectPins,
  shopPins,
  teamByRegion,
  territory,
} from "@/lib/services/sales-service";
import { today } from "@/lib/recompute";
import { Banner, MetricRow, Pill, ScreenHeader } from "../parts";
import { plural } from "../words";
import { ShopMap } from "./shop-map";

export const metadata = { title: "Territory — Sales Dashboard — MahekOne" };

const NO_REGION = "No region set";

/**
 * Which regions each salesman covers, who they report to, and where the book
 * actually sits on a map.
 *
 * From `MBOS Manager Console.dc.html`'s Territory screen: cards grouped by
 * where each person works, with a reporting-lines section above them. The
 * design groups by "state" with a direct salesman→manager card — this schema
 * has neither a `state` field (only `region`/`city`/`beat` on `customers`)
 * nor a per-territory manager assignment, so the card is built from what IS
 * real: `region` (a salesman has none of his own, only a book of customers
 * that each carry one — this is the region the MOST of his book sits in) and
 * `users.reports_to_id`, the same general reporting line
 * `access-control.ts` already reads for scope.
 *
 * The map and its stats (Shops / Cities / Regions / In nobody's book /
 * Without a pin) are `territory()`'s own — real, already-shipped signal this
 * screen had before the redesign, kept rather than replaced. Only the flat
 * region/city/beat table and the "who covers what" chip row are replaced,
 * by the region cards and reporting lines below.
 */
export default async function Page() {
  const day = await today();
  const [rows, gap, team, byRegion, shopMapPins, prospectMapPins] = await Promise.all([
    territory(),
    gpsGap(),
    fieldTeam(),
    teamByRegion(day),
    shopPins(),
    prospectPins(),
  ]);

  const unassigned = rows.filter((r) => !r.salesmanId);
  const regionsFromBook = new Set(rows.map((r) => r.region ?? "—"));
  const citiesFromBook = new Set(rows.map((r) => r.city));
  const shops = rows.reduce((n, r) => n + r.shops, 0);

  const byPersonShops = new Map<string, number>();
  for (const r of rows) {
    if (!r.salesmanId) continue;
    byPersonShops.set(r.salesmanId, (byPersonShops.get(r.salesmanId) ?? 0) + r.shops);
  }
  const covering = team.filter((t) => t.active && !byPersonShops.has(t.id));

  const regionGroups = new Map<string, typeof byRegion>();
  for (const t of byRegion) {
    const key = t.region ?? NO_REGION;
    const at = regionGroups.get(key) ?? [];
    at.push(t);
    regionGroups.set(key, at);
  }
  const regions = [...regionGroups.entries()].sort((a, b) => {
    if (a[0] === NO_REGION) return 1;
    if (b[0] === NO_REGION) return -1;
    return b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });

  const covered = byRegion.filter((t) => t.shopCount > 0);
  const cityCounts = covered.map((t) => t.cities.length);

  const byManager = new Map<string, { name: string; regions: Set<string>; count: number }>();
  for (const t of byRegion) {
    if (!t.reportsToId) continue;
    const at = byManager.get(t.reportsToId) ?? {
      name: t.reportsToName ?? "—",
      regions: new Set<string>(),
      count: 0,
    };
    at.count += 1;
    if (t.region) at.regions.add(t.region);
    byManager.set(t.reportsToId, at);
  }
  const managers = [...byManager.values()].sort((a, b) => b.count - a.count);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Territory"
        subtitle="Which regions, cities and beats belong to whom, and who each salesman reports to. Whose book a shop is in decides who is credited for its orders and whose figures it counts toward, so this is the map behind every other number in the console."
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
          { label: "Cities", value: String(citiesFromBook.size) },
          { label: "Regions", value: String(regionsFromBook.size) },
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

      <div className="mb-4">
        <div className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Where they are
        </div>
        <ShopMap shops={shopMapPins} prospects={prospectMapPins} />
      </div>

      {managers.length ? (
        <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
          <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Reporting lines
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {managers.map((m) => (
              <span key={m.name} className="block min-w-0">
                <span className="block text-[15px] font-medium text-ink">{m.name}</span>
                <span className="mt-0.5 block text-[13px] text-muted">
                  {plural(m.count, "salesman", "salesmen")}
                </span>
                <span className="block text-[13px] text-muted">
                  {m.regions.size ? [...m.regions].join(" · ") : "No region yet"}
                </span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {regions.length === 0 ? (
        <div className="rounded-[6px] border border-line bg-surface px-6 py-14 text-center">
          <div className="text-lg font-semibold text-ink">Nobody holds the Salesman App</div>
          <p className="mx-auto mt-1.5 max-w-[480px] text-[15px] text-pretty text-muted">
            Territory is built from who holds the `field` app and the customers named against
            them. Grant it on the Access screen in the Admin Console.
          </p>
        </div>
      ) : (
        <>
          {cityCounts.length ? (
            <div className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {plural(covered.length, "salesman", "salesmen")} covering shops, {Math.min(...cityCounts)}
              –{Math.max(...cityCounts)} cities each
            </div>
          ) : null}
          <div style={{ columns: "340px", columnGap: "16px" }}>
            {regions.map(([region, men]) => (
              <div
                key={region}
                className="mb-4 overflow-hidden rounded-[6px] border border-line bg-surface"
                style={{ breakInside: "avoid" }}
              >
                <div className="border-b border-divider px-4 py-3.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[17px] font-semibold text-ink">{region}</span>
                  </div>
                  <div className="mt-0.5 text-[13px] text-muted">
                    {plural(men.length, "salesman", "salesmen")} ·{" "}
                    {plural(new Set(men.flatMap((m) => m.cities)).size, "city", "cities")}
                  </div>
                </div>
                {men.map((p) => {
                  const shopCount = byPersonShops.get(p.salesmanId);
                  return (
                    <Link
                      key={p.salesmanId}
                      href={`/sales/people/${p.salesmanId}`}
                      className="flex items-center gap-3 border-t border-divider px-4 py-3 no-underline first:border-t-0 hover:bg-canvas hover:no-underline"
                    >
                      <span
                        className={cx(
                          "flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold",
                          p.checkedInToday ? "bg-brand-soft text-[#5223E0]" : "bg-divider text-muted",
                        )}
                      >
                        {p.initials}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-ink">{p.salesmanName}</span>
                          <Pill tone={p.onLeaveToday ? "neutral" : p.checkedInToday ? "success" : "danger"}>
                            {p.onLeaveToday ? "On leave" : p.checkedInToday ? "In the field" : "Not started"}
                          </Pill>
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] text-muted">
                          {p.cities.length ? p.cities.join(" · ") : "No customers named yet"}
                        </span>
                      </span>
                      <span className="flex-none text-[12px] text-muted">
                        {shopCount ? plural(shopCount, "shop") : plural(p.cities.length, "city", "cities")}
                      </span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}

      <p className="mt-4 max-w-[660px] text-[13px] leading-[19px] text-muted">
        A region is where most of a salesman&rsquo;s own book sits, not a territory assigned to
        them directly — a shop moved to a new sales account manager moves the count here on the
        next sync, without anybody redrawing a map.
      </p>
    </div>
  );
}
