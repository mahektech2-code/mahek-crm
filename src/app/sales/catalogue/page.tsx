import { getConfig } from "@/lib/config/store";
import { catalogueRows } from "@/lib/services/sales-service";
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

export const metadata = { title: "Catalogue & rates — Sales Dashboard — MahekOne" };

/**
 * What the app offers, and at what rate.
 *
 * Except that there are no rates, and this screen says so rather than showing
 * three columns of zeroes. The design has Retail / Dealer / Distributor;
 * MahekOne's product master carries no prices at all, `products.priceSource`
 * reads `unset`, and `canValueOrders()` answers no. Reaching for the packing
 * cost because it is the only number on the row would put believable wrong
 * figures on a rate card that salesmen quote from.
 *
 * What IS here is the catalogue as it actually exists: four levels, of which
 * only the bottom can be ordered, with the formulation shown as a subtitle —
 * one liquid sells as Nano, Astar Nano and M5x4, and a salesman told "M5x4"
 * must find it or conclude we do not stock it.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const search = (params.q ?? "").trim();

  const [rows, config] = await Promise.all([
    catalogueRows(search || undefined),
    getConfig(),
  ]);

  const priceSource = config["products.priceSource"];
  const active = rows.filter((r) => r.active);
  const held = rows.filter((r) => r.status !== "ok");

  return (
    <div className="p-6">
      <ScreenHeader
        title="Catalogue and rates"
        subtitle="What the app offers. A change here reaches every phone on the next sync — the handset never holds the whole catalogue, so a search on a phone is a search against this list."
      />

      {priceSource === "unset" ? (
        <Banner
          tone="warn"
          title="There are no rates to show"
          body="The product master carries no prices, and the price source setting reads “unset” — so every order is captured with quantities and no value, and this screen has nothing to put in a rate column. Deriving one from the packing cost would put a believable wrong figure on a card people quote from. Set products.priceSource once a price list exists."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Offered", value: String(active.length), sub: "orderable SKUs" },
          {
            label: "Retired",
            value: String(rows.length - active.length),
            sub: "kept, never deleted",
          },
          {
            label: "Held",
            value: String(held.length),
            sub: held.length ? "waiting on a decision" : undefined,
            tone: held.length ? "warn" : undefined,
          },
          { label: "Price source", value: String(priceSource) },
        ]}
      />

      <form className="mb-4">
        <input
          name="q"
          defaultValue={search}
          placeholder="Search a grade, a brand or a pack size — “epoxy”, “M5x4”, “20 Liter”"
          className="h-8.5 w-[440px] rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
        />
      </form>

      {rows.length === 0 ? (
        <Empty
          title={search ? "Nothing matches that" : "The catalogue is empty"}
          body={
            search
              ? "Try the grade, like “epoxy”, or a pack size. Search reaches the formulation and the brand as well as the SKU name, because one liquid sells under three names."
              : "No product has been imported. Regenerate the seed from the document with npm run catalogue:parse, then npm run catalogue:import."
          }
        />
      ) : (
        <>
          <Table
            minWidth={1100}
            head={
              <>
                <HeadCell width={320}>Product</HeadCell>
                <HeadCell width={150}>Pack</HeadCell>
                <HeadCell width={160}>Packing</HeadCell>
                <HeadCell align="right" width={120}>Per box</HeadCell>
                <HeadCell align="right" width={150}>Ordered</HeadCell>
                <HeadCell>State</HeadCell>
              </>
            }
          >
            {rows.map((p, i) => (
              <Row key={p.id} striped={i % 2 === 1}>
                <Cell truncate={320} title={p.rawName ?? undefined}>
                  <span className="font-medium text-ink">{p.name}</span>
                  {p.formulation || p.brand ? (
                    <span className="block truncate text-[12px] text-muted">
                      {[p.brand, p.formulation].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </Cell>
                <Cell>{p.packSize ?? <span className="text-muted">—</span>}</Cell>
                <Cell>{p.packing ?? <span className="text-muted">—</span>}</Cell>
                <Cell align="right">
                  {p.cansPerBox && p.cansPerBox > 1 ? (
                    plural(p.cansPerBox, "can")
                  ) : (
                    <span className="text-muted">loose</span>
                  )}
                </Cell>
                <Cell align="right">
                  {p.orderedCans ? (
                    plural(p.orderedCans, "can")
                  ) : (
                    <span className="text-muted">never</span>
                  )}
                </Cell>
                <Cell>
                  {!p.active ? (
                    <Pill>Retired</Pill>
                  ) : p.status !== "ok" ? (
                    <Pill tone="warn">{p.status.replace(/_/g, " ")}</Pill>
                  ) : (
                    <Pill tone="success">Offered</Pill>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>

          <p className="mt-3 max-w-[820px] text-[13px] text-pretty text-muted">
            A SKU&rsquo;s name is the join key — legacy orders and bills reference it as text — so
            it is never edited. A name that has to change becomes a new SKU plus an alias, and
            aliases resolve on the way in without being offered on an order form.
          </p>
        </>
      )}
    </div>
  );
}
