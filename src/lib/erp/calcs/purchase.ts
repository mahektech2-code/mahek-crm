import { fmt, n, registerCalc } from "../calc";
import { lotNumber, purchaseFigures } from "../engines/purchase";

/* ---------------------------------------------------------------------------
 * The purchase forms' derived fields. The server recomputes each on save from
 * the same engine; these show the figure before it is.
 * ------------------------------------------------------------------------- */

const map = (data: Record<string, unknown>, k: string) => (data[k] ?? {}) as Record<string, unknown>;

registerCalc("requisitions.unit", ({ h }) =>
  !h.type ? "" : h.type === "Chemical" ? "Liter" : h.type === "Finish Good" ? "Box" : "Pcs",
);

registerCalc("inward.pr", ({ h }) => (h.prFixed ? h.prFixed : "Next PR number, on save"));

registerCalc("inward.unit", ({ l, data }) => {
  if (!l.item) return "";
  if (l.type === "Box") return "Pcs";
  return String(map(data, "unitOf")[l.item] ?? "");
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
