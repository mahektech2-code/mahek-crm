import { fmt, n, registerCalc } from "../calc";
import { lotNumber, netWeight, purchaseFigures, transportCostPaise, transportModeByLabel } from "../engines/purchase";

/* ---------------------------------------------------------------------------
 * The purchase forms' derived fields. The server recomputes each on save from
 * the same engine; these show the figure before it is.
 * ------------------------------------------------------------------------- */

const map = (data: Record<string, unknown>, k: string) => (data[k] ?? {}) as Record<string, unknown>;

registerCalc("requisitions.unit", ({ h }) =>
  !h.type ? "" : h.type === "Chemical" ? "Liter" : h.type === "Finish Good" ? "Box" : "Pcs",
);

registerCalc("inward.pr", ({ h }) => (h.prFixed ? h.prFixed : "Next PR number, on save"));

/*
 * The item's stock, lot by lot, at the godown asking — then the total, then
 * what the other godowns hold, since a transfer may answer the need sooner
 * than a purchase. One line each.
 */
registerCalc("requisitions.onHand", ({ h, data }) => {
  if (!h.item) return "";
  const lots = ((map(data, "stockOf")[h.item] ?? []) as { lot: string; godown: string; qty: number; unit: string }[]).slice();
  const here = lots.filter((l) => l.godown === h.godown).sort((a, b) => b.qty - a.qty);
  const there = lots.filter((l) => l.godown !== h.godown);
  const unit = lots[0]?.unit ?? "";
  const lines: string[] = [];
  if (!here.length) lines.push(h.godown ? `None at ${h.godown}` : "Pick a godown");
  else {
    here.forEach((l) => lines.push(`Lot ${l.lot} · ${fmt(l.qty, 3)} ${l.unit}`));
    if (here.length > 1) lines.push(`Total · ${fmt(here.reduce((a, l) => a + l.qty, 0), 3)} ${unit}`);
  }
  const elsewhere = new Map<string, number>();
  there.forEach((l) => elsewhere.set(l.godown, (elsewhere.get(l.godown) ?? 0) + l.qty));
  if (elsewhere.size)
    lines.push(`Elsewhere · ${[...elsewhere].sort((a, b) => b[1] - a[1]).map(([g, q]) => `${g} ${fmt(q, 3)} ${unit}`).join(", ")}`);
  return lines.join("\n");
});

registerCalc("inward.unit", ({ l, data }) => {
  if (!l.item) return "";
  if (l.type === "Box") return "Pcs";
  return String(map(data, "unitOf")[l.item] ?? "");
});

registerCalc("inward.net", ({ l }) => {
  const net = netWeight(n(l.weight), n(l.drums), n(l.emptyDrum));
  if (net != null) return `${fmt(net, 3)} kg`;
  if (n(l.weight) && n(l.drums) != null && n(l.emptyDrum) != null) return "The empty drums weigh as much as the load — check the scale";
  return "Weight with drum − drums × empty drum weight";
});

registerCalc("inward.testing", ({ l, data }) => {
  if (!l.item) return "";
  const tests = (map(data, "testsOf")[l.item] ?? []) as string[];
  return tests.length ? `Yes · ${tests.join(", ")}` : "No · goes straight to the register";
});

registerCalc("testing.tests", ({ h, data }) => {
  if (!h.line) return "";
  const tests = (map(data, "testsOf")[h.line] ?? []) as string[];
  return tests.length ? tests.join(", ") : "None";
});

function figures(h: Record<string, string>, data: Record<string, unknown>) {
  const density = n(h.density) ?? ((map(data, "densityOf")[h.item] as number | null) ?? null);
  const rate = n(h.rate);
  return purchaseFigures({
    quantity: n(h.qty) ?? 0,
    unit: h.unit || "Litre",
    ratePaise: rate == null || Number.isNaN(rate) ? null : Math.round(rate * 100),
    density,
    feedAdjustedLitre: n(h.feedLitre) ?? 0,
    feedAdjustedAmountPaise: Math.round((n(h.feedAmount) ?? 0) * 100),
    gstBp: Math.round((n(h.gst) ?? 18) * 100),
    drums: n(h.drums),
  });
}

registerCalc("register.lot", ({ h, data }) => {
  if (!h.supplier || !h.item) return "";
  const party = String(map(data, "partyCode")[h.supplier] ?? "");
  const item = String(map(data, "itemCode")[h.item] ?? "");
  const pr = n(h.pr);
  if (pr == null || Number.isNaN(pr)) return `${party}${item} + the next PR number`;
  return lotNumber(party, item, pr);
});

registerCalc("register.litres", ({ h, data }) => {
  if (!n(h.qty)) return "";
  if (h.unit === "Kg" && !n(h.density) && !map(data, "densityOf")[h.item]) return "Needs a density";
  return fmt(figures(h, data).inLitre, 0);
});

registerCalc("register.available", ({ h, data }) => (n(h.qty) ? fmt(figures(h, data).availableLitres, 0) : ""));

registerCalc("register.final", ({ h, data }) => {
  const f = figures(h, data);
  if (f.finalPaise == null) return "Enter a rate";
  return `₹${fmt(f.finalPaise / 100)}`;
});

registerCalc("register.summary", ({ h, data }) => {
  const f = figures(h, data);
  if (!n(h.qty)) return "";
  return f.finalPaise == null || f.finalPaise <= 0
    ? `warn:No rate yet — this lot will not reach stock until a rate above zero is entered.`
    : `ok:Posts ${fmt(f.availableLitres, 0)} to stock at the chosen godown.`;
});

/* Transport and other inward cost, once per PR (see erp_pr_costs). */
function inwardCosts(h: Record<string, string>, data: Record<string, unknown>) {
  const mode = transportModeByLabel(h.transportMode);
  if (!mode) return null;
  const rupees = (v: string | undefined) => {
    const x = n(v);
    return x == null || Number.isNaN(x) ? null : Math.round(x * 100);
  };
  const ratePerKmPaise = Number(data.ratePerKmPaise ?? 0);
  const transport = transportCostPaise({ mode, billedPaise: rupees(h.transportCost), km: n(h.km), ratePerKmPaise });
  return { mode, transport, other: rupees(h.otherCost) ?? 0, ratePerKmPaise };
}

registerCalc("inward.ownCost", ({ h, data }) => {
  const c = inwardCosts(h, data);
  if (!c) return "";
  if (!c.ratePerKmPaise) return "No approved ₹/KM rate yet — an admin sets it in ERP settings";
  if (c.transport == null) return `Kilometres × ₹${fmt(c.ratePerKmPaise / 100)} a km`;
  return `₹${fmt(c.transport / 100)} · ${fmt(n(h.km) ?? 0, 1)} km × ₹${fmt(c.ratePerKmPaise / 100)}`;
});

registerCalc("inward.landing", ({ h, data }) => {
  const c = inwardCosts(h, data);
  if (!c || c.transport == null) return "";
  const total = c.transport + c.other;
  if (!total) return "No transport or other cost — landing cost is the material cost.";
  return `₹${fmt(total / 100)} to add to the material cost, shared across the items by value once their rates are in.`;
});
