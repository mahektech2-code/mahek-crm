import "server-only";
import type { ErpContext } from "./access";
import { erpHref, erpScreen } from "./registry";
import { loadCustomers, partyStatus } from "./screens/masters";
import { billsAwaitingIds, inwardAwaitingIds, rateMissingIds, testsAwaitingIds } from "./counts";
import { rmLots } from "./stock";
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
