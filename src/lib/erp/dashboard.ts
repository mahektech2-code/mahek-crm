import "server-only";
import type { ErpContext } from "./access";
import { erpHref, erpScreen } from "./registry";
import { loadCustomers, partyStatus } from "./screens/masters";
import { billsAwaitingIds, incompletePackIds, inwardAwaitingIds, rateMissingIds, salesCounts, testsAwaitingIds, unverifiedIds } from "./counts";
import { detailRows } from "./screens/sales";
import { today } from "./screens/common";
import { fgReorderRows, rmReorderRows } from "./screens/movement";
import { fgLots, packLots, rmLots, sfgLots } from "./stock";
import { nf } from "./ui";
import type { Tone } from "./ui";

/* ---------------------------------------------------------------------------
 * The ERP dashboard (PRD §6, spec §13.6): what needs attention now, from data
 * the modules already hold. Every tile names the rows it counted, so opening
 * it lands on exactly those rows, and a tile for a screen the person does not
 * hold — or a money figure without its power — is never built at all.
 *
 * Each phase adds the sections for the screens it builds.
 * ------------------------------------------------------------------------- */

export type Tile = {
  l: string;
  v: string;
  sub?: string;
  tone?: Tone;
  href: string;
};

export type Section = { t: string; tiles: Tile[] };

/** A link to a screen, pre-filtered to the ids a tile counted. */
export function tileHref(screen: string, ids: string[] | null, label: string): string {
  const s = erpScreen(screen);
  const base = s ? erpHref(s) : "/erp";
  if (!ids) return base;
  return `${base}?f=${encodeURIComponent(ids.join(","))}&fl=${encodeURIComponent(label)}`;
}

export async function dashboardSections(ctx: ErpContext, godownName: string | null): Promise<Section[]> {
  const out: Section[] = [];

  const sales: Tile[] = [];
  if (ctx.screens.has("pendingOrders") || ctx.screens.has("readyOrders") || ctx.screens.has("orders")) {
    const c = await salesCounts();
    const here = <T extends { godown: string }>(xs: T[]) => xs.filter((l) => !godownName || l.godown === godownName);
    const pending = here(c.pending);
    const toAllocate = here(c.toAllocate);
    const partyWait = here(c.pendingParty);
    if (ctx.screens.has("pendingOrders"))
      sales.push({ l: "Pending order lines", v: String(pending.length), sub: "not yet in order details", href: tileHref("pendingOrders", null, "") });
    if (ctx.screens.has("readyOrders"))
      sales.push({ l: "Ready, lots to allocate", v: String(toAllocate.length), sub: "allocate before marking Done", tone: toAllocate.length ? "warn" : undefined, href: tileHref("readyOrders", toAllocate.map((l) => l.o.id), "To allocate") });
    if (ctx.screens.has("orders") && partyWait.length)
      sales.push({ l: "Orders from pending parties", v: String(partyWait.length), sub: "the party needs activating or the order approving", tone: "warn", href: tileHref("orders", partyWait.map((l) => l.o.id), "Pending party") });
  }
  if (ctx.screens.has("orderDetails")) {
    const ids = await unverifiedIds();
    sales.push({ l: "Awaiting dispatch verification", v: String(ids.length), sub: "enter the dispatch date once it has left", tone: ids.length ? "warn" : undefined, href: tileHref("orderDetails", ids, "Not verified") });
    if (ctx.powers.has("viewSalesAmounts")) {
      const month = today().slice(0, 7);
      const { rows } = await detailRows();
      const sold = rows.filter((r) => r.d.verification === "Verified" && (r.d.dispatchDate ?? "").startsWith(month) && (!godownName || r.l.godown === godownName));
      const total = sold.reduce((a, r) => a + (r.amount ?? 0) - (r.discounted ?? 0), 0);
      sales.push({ l: "Dispatched this month", v: `₹${nf(Math.round(total / 100))}`, sub: `${sold.length} line${sold.length === 1 ? "" : "s"}, before GST`, href: tileHref("orderDetails", sold.map((r) => r.l.o.id), "Dispatched this month") });
    }
  }
  if (sales.length) out.push({ t: "Sales", tiles: sales });

  const purchase: Tile[] = [];
  if (ctx.screens.has("inward")) {
    const ids = await inwardAwaitingIds();
    purchase.push({ l: "Inward awaiting routing", v: String(ids.length), sub: "send to testing or the register", tone: ids.length ? "warn" : undefined, href: tileHref("inward", ids, "Awaiting routing") });
  }
  if (ctx.screens.has("testing")) {
    const ids = await testsAwaitingIds();
    purchase.push({ l: "Tests to decide", v: String(ids.length), sub: ctx.powers.has("verifyTest") ? "you verify these" : "the verifier decides", tone: ids.length ? "warn" : undefined, href: tileHref("testing", ids, "Not decided") });
  }
  if (ctx.screens.has("register") && ctx.powers.has("viewPurchaseMoney")) {
    const noRate = await rateMissingIds();
    purchase.push({ l: "Purchases without a rate", v: String(noRate.length), sub: "not in stock until rated", tone: noRate.length ? "danger" : undefined, href: tileHref("register", noRate, "Rate missing") });
    const bills = await billsAwaitingIds();
    purchase.push({ l: "Bills not received", v: String(bills.length), href: tileHref("register", bills, "Bill not received") });
  }
  if (purchase.length) out.push({ t: "Purchase", tiles: purchase });

  if (ctx.screens.has("rmStock")) {
    const lots = (await rmLots()).filter((l) => l.stock > 0 && (!godownName || l.godown === godownName));
    const litres = lots.filter((l) => l.unit === "Ltr").reduce((a, l) => a + l.stock, 0);
    const tiles: Tile[] = [
      { l: godownName ? `Raw-material lots · ${godownName}` : "Raw-material lots", v: String(lots.length), sub: `${nf(litres)} Ltr in stock`, href: tileHref("rmStock", null, "") },
    ];
    if (ctx.powers.has("viewCost")) {
      const value = lots.reduce((a, l) => a + (l.ratePaise == null ? 0 : l.ratePaise * l.stock), 0);
      tiles.push({ l: "Raw-material value", v: `₹${nf(Math.round(value / 100))}`, sub: "at purchase rate", href: tileHref("rmStock", null, "") });
    }
    out.push({ t: "Raw-material stock", tiles });
  }

  const stock: Tile[] = [];
  const here = <T extends { godown: string; stock: number }>(xs: T[]) => xs.filter((l) => l.stock > 0 && (!godownName || l.godown === godownName));
  if (ctx.screens.has("sfgStock")) {
    const lots = here(await sfgLots());
    stock.push({ l: "SFG in stock", v: `${nf(lots.reduce((a, l) => a + l.stock, 0))} Ltr`, sub: `${lots.length} lot${lots.length === 1 ? "" : "s"}`, href: tileHref("sfgStock", null, "") });
  }
  if (ctx.screens.has("fgStock")) {
    const lots = here(await fgLots());
    stock.push({ l: "Loose FG in stock", v: `${nf(lots.reduce((a, l) => a + l.stock, 0))} cans`, sub: `${lots.length} lot${lots.length === 1 ? "" : "s"}`, href: tileHref("fgStock", null, "") });
  }
  if (ctx.screens.has("packStock")) {
    const lots = here(await packLots());
    stock.push({ l: "Boxed stock", v: `${nf(lots.reduce((a, l) => a + l.stock, 0))} boxes`, sub: `${lots.length} batch${lots.length === 1 ? "" : "es"}`, href: tileHref("packStock", null, "") });
  }
  if (ctx.screens.has("packBatches")) {
    const ids = await incompletePackIds();
    stock.push({ l: "Packing batches incomplete", v: String(ids.length), sub: "boxes not in stock until the cans match", tone: ids.length ? "warn" : undefined, href: tileHref("packBatches", ids, "Incomplete") });
  }
  if (stock.length) out.push({ t: "Production", tiles: stock });

  const reorder: Tile[] = [];
  if (ctx.screens.has("reorderRm")) {
    const rows = (await rmReorderRows()).filter((r) => !godownName || r.godown === godownName);
    reorder.push({ l: "Raw items to re-order", v: String(rows.length), sub: "followed items below their level", tone: rows.length ? "danger" : undefined, href: tileHref("reorderRm", null, "") });
  }
  if (ctx.screens.has("reorderFg")) {
    const rows = (await fgReorderRows()).filter((r) => !godownName || r.godown === godownName);
    reorder.push({ l: "Finished goods to re-order", v: String(rows.length), sub: "followed SKUs below their minimum", tone: rows.length ? "danger" : undefined, href: tileHref("reorderFg", null, "") });
  }
  if (reorder.length) out.push({ t: "Re-order", tiles: reorder });

  if (ctx.screens.has("customers")) {
    const tiles: Tile[] = [];
    if (ctx.powers.has("customerStatus")) {
      const pending = (await loadCustomers()).filter((c) => partyStatus(c) === "Pending");
      tiles.push({
        l: "Pending activation",
        v: String(pending.length),
        sub: "an admin activates them",
        tone: pending.length ? "warn" : undefined,
        href: tileHref("customers", pending.map((c) => c.id), "Pending"),
      });
    }
    if (tiles.length) out.push({ t: "Customers", tiles });
  }

  return out;
}
