"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { C, EASE, Hov, Icon, upper } from "../../(command)/ui";
import { TitleBlock } from "../../(command)/chrome";
import { CardGrid } from "@/components/ui/card-grid";
import { moneyShort, signedMoney } from "@/lib/format";
import type { PeriodState } from "@/lib/command-centre/types";
import {
  BAND_LABEL,
  BAND_ORDER,
  bandOf,
  bandRange,
  bridge,
  linePct,
  marginAlerts,
  rollup,
  salesOf,
  totals,
  underFloor,
  type Band,
  type Bridge,
  type MarginAlert,
  type MarginLine,
  type MarginRules,
  type Totals,
} from "@/lib/engines/margins";

/* ---------------------------------------------------------------------------
 * THE MARGINS DESK, drawn in the Command Centre's own furniture.
 *
 * One section, six sub-tabs, and a View switch inside a tab where one subject
 * is read several ways — so the seventeen screens of the first design fit
 * the Command Centre's sidebar as ONE entry. Every figure is the engine's
 * (`lib/engines/margins.ts`) over the lines the page read; filters narrow the
 * LINES before anything is added up, so a product's margin with a salesman
 * picked is that salesman's margin on that product, not the product's whole
 * margin shown on a narrower list.
 *
 * What is remembered — columns, the focus list, saved views, which Overview
 * panels show — is remembered in this browser, per person. None of it moves a
 * figure, and none of it is anybody else's business.
 * ------------------------------------------------------------------------- */

type Props = {
  period: PeriodState;
  cur: MarginLine[];
  prev: MarginLine[] | null;
  tooWide: number | null;
  cap: number;
  rules: MarginRules;
  rulesHref: string | null;
  initialView: string | null;
};

/* ------------------------------------------------------------------ words */

const rs = (p: number | null | undefined) => (p == null ? "—" : signedMoney(Math.round(p / 100) * 100));
const short = (p: number | null | undefined) => (p == null ? "—" : moneyShort(Math.round(p / 100) * 100));
const pctText = (p: number | null | undefined) => (p == null ? "—" : `${p.toFixed(1)}%`);
const litres = (n: number) => `${Math.round(n).toLocaleString("en-IN")} L`;
const whole = (n: number) => Math.round(n).toLocaleString("en-IN");
const perL = (p: number | null | undefined) => (p == null ? "—" : `₹${(p / 100).toFixed(1)}/L`);
const arrow = (d: number) => (d > 0 ? "▲" : d < 0 ? "▼" : "");
const ppText = (d: number | null) => (d == null ? "" : `${arrow(d)}${Math.abs(d).toFixed(1)} pp`);
const chgText = (a: number, b: number | null | undefined) => (b == null || b === 0 ? "" : `${arrow(a - b)}${Math.abs(((a - b) / Math.abs(b)) * 100).toFixed(0)}%`);
const toneOf = (d: number | null | undefined) => (d == null || Math.abs(d) < 1e-9 ? C.muted : d > 0 ? C.good : C.bad);

const BAND_TONE: Record<Band, [string, string]> = {
  healthy: [C.goodTint, C.good],
  fair: [C.blueTint, C.blue],
  thin: [C.warnTint, C.warnInk],
  loss: [C.badTint, C.bad],
  nocost: [C.warnTint, C.warnInk],
};
const BAND_BAR: Record<Band, string> = { healthy: C.good, fair: C.blue, thin: C.warn, loss: C.bad, nocost: C.faint };

/* ----------------------------------------------------------- remembered */

const storeListeners = new Set<() => void>();
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const raw = React.useSyncExternalStore(
    (cb) => {
      storeListeners.add(cb);
      return () => storeListeners.delete(cb);
    },
    () => readStored(key),
    () => null,
  );
  const value = React.useMemo(() => {
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }, [raw, fallback]);
  const set = React.useCallback(
    (v: T) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* Storage refused: it simply is not remembered. */
      }
      storeListeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}

const NO_STRINGS: string[] = [];
const NO_VIEWS: SavedView[] = [];
const NO_HIDDEN: Record<string, string[]> = {};
const WIDGETS_DEFAULT: Record<string, boolean> = { tiles: true, waterfall: true, bridge: true, bands: true, movers: true, salesmen: true, alerts: true };

/* --------------------------------------------------------------- the tabs */

type ViewKey =
  | "company" | "needs"
  | "sku" | "formulation" | "lots"
  | "customers" | "top"
  | "salesmen" | "city" | "district" | "state"
  | "lines" | "discounts" | "extras" | "credit"
  | "cmp-product" | "cmp-customer" | "cmp-salesman";

type TabKey = "overview" | "products" | "customers" | "team" | "lines" | "compare";

const TABS: { key: TabKey; label: string; views: [ViewKey, string][] }[] = [
  { key: "overview", label: "Overview", views: [["company", "Company"], ["needs", "Needs a look"]] },
  { key: "products", label: "Products", views: [["sku", "SKUs"], ["formulation", "Formulations"], ["lots", "Lots"]] },
  { key: "customers", label: "Customers", views: [["customers", "Every customer"], ["top", "Top & focus"]] },
  { key: "team", label: "Salesmen & places", views: [["salesmen", "Salesmen"], ["city", "Cities"], ["district", "Districts"], ["state", "States"]] },
  { key: "lines", label: "Lines & leakage", views: [["lines", "Every line"], ["discounts", "Discounts"], ["extras", "Extra expenses"], ["credit", "Credit notes"]] },
  { key: "compare", label: "Why it moved", views: [["cmp-product", "By product"], ["cmp-customer", "By customer"], ["cmp-salesman", "By salesman"]] },
];

const tabOfView = (v: ViewKey): TabKey => TABS.find((t) => t.views.some((x) => x[0] === v))!.key;

/* ------------------------------------------------------------------ rows */

type Row = {
  key: string;
  title: string;
  sub?: string;
  kind: string;
  lines: MarginLine[];
  t: Totals;
  prev: Totals | null;
  band: Band;
  line?: MarginLine;
  bridge?: Bridge;
  alert?: MarginAlert;
  focus?: boolean;
};

type ColSet = "agg" | "line" | "bridge" | "alert";

const FACETS: [keyof MarginLine, string][] = [
  ["salesman", "Salesman"],
  ["formulation", "Formulation"],
  ["state", "State"],
  ["city", "City"],
  ["godown", "Godown"],
];
const FLAGS = ["Under the floor", "No lot cost", "Has a discount", "Has extra expenses", "Has a credit note"] as const;

function flagsOf(l: MarginLine, r: MarginRules): string[] {
  const out: string[] = [];
  if (underFloor(l, r)) out.push("Under the floor");
  if (l.marginPaise == null) out.push("No lot cost");
  if (l.discountPaise > 0) out.push("Has a discount");
  if (l.extraPaise > 0) out.push("Has extra expenses");
  if (l.creditNotePaise > 0) out.push("Has a credit note");
  return out;
}

function aggRows(cur: MarginLine[], prev: MarginLine[] | null, keyOf: (l: MarginLine) => string, label: (l: MarginLine) => [string, string?], kind: string, r: MarginRules): Row[] {
  return rollup(cur, prev, keyOf).map((x) => {
    const [title, sub] = label(x.lines[0]!);
    return { key: `${kind}:${x.key}`, title, sub, kind, lines: x.lines, t: x.t, prev: x.prev, band: bandOf(x.t.pct, r) };
  });
}

function rowsFor(view: ViewKey, cur: MarginLine[], prev: MarginLine[] | null, r: MarginRules, focus: string[], alerts: MarginAlert[]): { rows: Row[]; set: ColSet } {
  const lineRow = (l: MarginLine): Row => {
    const t = totals([l]);
    return { key: `line:${l.id}`, title: `${l.orderNo} · ${l.customer}`, sub: l.product, kind: "Order line", lines: [l], t, prev: null, band: bandOf(linePct(l), r), line: l };
  };
  switch (view) {
    case "sku":
      return { set: "agg", rows: aggRows(cur, prev, (l) => l.product, (l) => [l.product, l.formulation], "Product", r) };
    case "formulation":
      return { set: "agg", rows: aggRows(cur, prev, (l) => l.formulation, (l) => [l.formulation], "Formulation", r) };
    case "lots":
      return { set: "agg", rows: aggRows(cur, null, (l) => (l.lots.length ? l.lots.join(", ") : "No lot allocated"), (l) => [l.lots.length ? l.lots.join(", ") : "No lot allocated", l.product], "Lot", r) };
    case "customers":
    case "top": {
      const rows = aggRows(cur, prev, (l) => l.customerId, (l) => [l.customer, `${l.salesman} · ${l.city}`], "Customer", r).map((x) => ({ ...x, focus: focus.includes(x.lines[0]!.customerId) }));
      if (view === "customers") return { set: "agg", rows };
      const all = totals(cur).sales;
      let run = 0;
      const ranked = [...rows].sort((a, b) => b.t.sales - a.t.sales);
      const top = ranked.filter((x) => {
        const inTop = run < all * 0.75;
        run += x.t.sales;
        return inTop || x.focus;
      });
      return { set: "agg", rows: top };
    }
    case "salesmen":
      return { set: "agg", rows: aggRows(cur, prev, (l) => l.salesman, (l) => [l.salesman], "Salesman", r) };
    case "city":
      return { set: "agg", rows: aggRows(cur, prev, (l) => `${l.state}|${l.district}|${l.city}`, (l) => [l.city, `${l.district} · ${l.state}`], "City", r) };
    case "district":
      return { set: "agg", rows: aggRows(cur, prev, (l) => `${l.state}|${l.district}`, (l) => [l.district, l.state], "District", r) };
    case "state":
      return { set: "agg", rows: aggRows(cur, prev, (l) => l.state, (l) => [l.state], "State", r) };
    case "lines":
      return { set: "line", rows: cur.map(lineRow) };
    case "discounts":
      return { set: "line", rows: cur.filter((l) => l.discountPaise > 0).map(lineRow) };
    case "extras":
      return { set: "line", rows: cur.filter((l) => l.extraPaise > 0).map(lineRow) };
    case "credit":
      return { set: "line", rows: cur.filter((l) => l.creditNotePaise > 0).map(lineRow) };
    case "cmp-product":
    case "cmp-customer":
    case "cmp-salesman": {
      if (!prev) return { set: "bridge", rows: [] };
      const keyOf = view === "cmp-product" ? (l: MarginLine) => l.product : view === "cmp-customer" ? (l: MarginLine) => l.customerId : (l: MarginLine) => l.salesman;
      const name = view === "cmp-customer" ? (l: MarginLine) => l.customer : keyOf;
      const before = new Map<string, MarginLine[]>();
      for (const l of prev) before.set(keyOf(l), [...(before.get(keyOf(l)) ?? []), l]);
      return {
        set: "bridge",
        rows: rollup(cur, prev, keyOf)
          .filter((x) => x.prev)
          .map((x) => ({ key: `bridge:${view}:${x.key}`, title: name(x.lines[0]!), kind: "Why it moved", lines: x.lines, t: x.t, prev: x.prev, band: bandOf(x.t.pct, r), bridge: bridge(x.lines, before.get(x.key) ?? []) })),
      };
    }
    case "needs":
      return {
        set: "alert",
        rows: alerts.map((a) => ({ key: `alert:${a.id}`, title: a.title, sub: a.body, kind: "Needs a look", lines: [], t: totals([]), prev: null, band: "nocost" as Band, alert: a })),
      };
    default:
      return { set: "agg", rows: [] };
  }
}

/** Quick "Show" chips — row-level, one at a time. */
function showsFor(view: ViewKey, r: MarginRules): [string, string, (x: Row) => boolean][] {
  const all: [string, string, (x: Row) => boolean] = ["all", "Everything", () => true];
  const fell: [string, string, (x: Row) => boolean] = ["fell", "Margin fell", (x) => !!x.prev && x.prev.pct != null && x.t.pct != null && x.t.pct < x.prev.pct];
  const under: [string, string, (x: Row) => boolean] = ["under", `Under ${r.floorPercent}%`, (x) => x.t.pct != null && x.t.pct < r.floorPercent];
  const nocost: [string, string, (x: Row) => boolean] = ["nocost", "Has lines with no lot cost", (x) => x.t.noCost > 0];
  if (["sku", "formulation", "salesmen", "city", "district", "state"].includes(view)) return [all, under, fell, nocost];
  if (view === "customers" || view === "top") return [all, under, fell, ["focus", "Focus list", (x) => !!x.focus], ["down", "Sales down", (x) => !!x.prev && x.t.sales < x.prev.sales]];
  if (view === "lots") return [all, ["none", "No lot allocated", (x) => x.t.noCost > 0], under];
  if (["lines", "discounts", "extras", "credit"].includes(view)) return [all, ["under", `Under ${r.floorPercent}%`, (x) => !!x.line && underFloor(x.line, r)], ["nocost", "No lot cost", (x) => x.t.noCost > 0]];
  if (view.startsWith("cmp-")) return [all, ["down", "Margin down", (x) => !!x.bridge && x.bridge.margin < x.bridge.prevMargin], ["up", "Margin up", (x) => !!x.bridge && x.bridge.margin > x.bridge.prevMargin]];
  return [all];
}

/* --------------------------------------------------------------- columns */

type Col = { k: string; l: string; right?: boolean; hide?: boolean; get: (x: Row) => number | string | null; cell: (x: Row) => React.ReactNode; csv: (x: Row) => string };

const Sub = ({ children, color }: { children: React.ReactNode; color?: string }) => <span style={{ display: "block", fontSize: 12, color: color ?? C.muted, marginTop: 1, whiteSpace: "nowrap" }}>{children}</span>;
const Mono = ({ children, color, bold }: { children: React.ReactNode; color?: string; bold?: boolean }) => (
  <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', fontSize: 13, color: color ?? C.ink, fontWeight: bold ? 600 : 400 }}>{children}</span>
);

function BandPill({ pct, band, title }: { pct: number | null; band: Band; title?: string }) {
  const [bg, fg] = BAND_TONE[band];
  return (
    <span title={title ?? BAND_LABEL[band]} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 10, fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", background: bg, color: fg }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "block" }} />
      {pct == null ? "No lot cost" : pctText(pct)}
    </span>
  );
}

function aggCols(r: MarginRules, total: number): Col[] {
  return [
    {
      k: "name", l: "Name", get: (x) => x.title, csv: (x) => x.title,
      cell: (x) => (
        <>
          <span style={{ color: C.ink, fontWeight: 500, whiteSpace: "normal" }}>{x.title}</span>
          {x.focus ? <Tag tone="info">FOCUS</Tag> : null}
          {x.t.noCost ? <Tag tone="warn">{`NO LOT COST · ${x.t.noCost}`}</Tag> : x.t.pct != null && x.t.pct < r.floorPercent ? <Tag tone="bad">UNDER FLOOR</Tag> : null}
          {x.sub ? <Sub>{x.sub}</Sub> : null}
        </>
      ),
    },
    { k: "orders", l: "Orders", right: true, get: (x) => x.t.orders, csv: (x) => String(x.t.orders), cell: (x) => <><Mono>{whole(x.t.orders)}</Mono>{x.prev ? <Sub>prev {whole(x.prev.orders)}</Sub> : null}</> },
    { k: "cans", l: "Cans", right: true, hide: true, get: (x) => x.t.cans, csv: (x) => String(x.t.cans), cell: (x) => <Mono>{whole(x.t.cans)}</Mono> },
    { k: "litres", l: "Litres", right: true, get: (x) => x.t.litres, csv: (x) => String(Math.round(x.t.litres)), cell: (x) => <><Mono>{litres(x.t.litres)}</Mono>{x.prev ? <Sub color={toneOf(x.t.litres - x.prev.litres)}>{chgText(x.t.litres, x.prev.litres)}</Sub> : null}</> },
    {
      k: "sales", l: "Sales", right: true, get: (x) => x.t.sales, csv: (x) => String(Math.round(x.t.sales / 100)),
      cell: (x) => <><Mono bold>{rs(x.t.sales)}</Mono>{x.prev ? <Sub>prev {rs(x.prev.sales)} <span style={{ color: toneOf(x.t.sales - x.prev.sales) }}>{chgText(x.t.sales, x.prev.sales)}</span></Sub> : null}</>,
    },
    {
      k: "rate", l: "Rate / L", right: true, get: (x) => x.t.ratePerLitre, csv: (x) => (x.t.ratePerLitre == null ? "" : (x.t.ratePerLitre / 100).toFixed(1)),
      cell: (x) => <><Mono>{perL(x.t.ratePerLitre)}</Mono>{x.prev?.ratePerLitre != null && x.t.ratePerLitre != null ? <Sub color={toneOf(x.t.ratePerLitre - x.prev.ratePerLitre)}>{chgText(x.t.ratePerLitre, x.prev.ratePerLitre)} vs {perL(x.prev.ratePerLitre)}</Sub> : null}</>,
    },
    { k: "cost", l: "Lot cost / L", right: true, get: (x) => x.t.costPerLitre, csv: (x) => (x.t.costPerLitre == null ? "" : (x.t.costPerLitre / 100).toFixed(1)), cell: (x) => <Mono>{perL(x.t.costPerLitre)}</Mono> },
    { k: "discount", l: "Discount", right: true, hide: true, get: (x) => x.t.discount, csv: (x) => String(Math.round(x.t.discount / 100)), cell: (x) => <Mono>{x.t.discount ? rs(x.t.discount) : "—"}</Mono> },
    { k: "extra", l: "Extra exp.", right: true, hide: true, get: (x) => x.t.extra, csv: (x) => String(Math.round(x.t.extra / 100)), cell: (x) => <Mono>{x.t.extra ? rs(x.t.extra) : "—"}</Mono> },
    { k: "credit", l: "Credit notes", right: true, hide: true, get: (x) => x.t.creditNote, csv: (x) => String(Math.round(x.t.creditNote / 100)), cell: (x) => <Mono>{x.t.creditNote ? rs(x.t.creditNote) : "—"}</Mono> },
    {
      k: "margin", l: "Gross margin", right: true, get: (x) => x.t.margin, csv: (x) => String(Math.round(x.t.margin / 100)),
      cell: (x) => <>{x.t.costedSales ? <Mono color={C.good} bold>{rs(x.t.margin)}</Mono> : <span style={{ color: C.warnInk }}>Unknown</span>}{x.prev && x.t.costedSales ?<Sub>prev {rs(x.prev.margin)} <span style={{ color: toneOf(x.t.margin - x.prev.margin) }}>{chgText(x.t.margin, x.prev.margin)}</span></Sub> : null}</>,
    },
    {
      k: "pct", l: "Margin %", get: (x) => x.t.pct, csv: (x) => (x.t.pct == null ? "" : x.t.pct.toFixed(1)),
      cell: (x) => <><BandPill pct={x.t.pct} band={x.band} />{x.prev?.pct != null && x.t.pct != null ? <Sub color={toneOf(x.t.pct - x.prev.pct)}>{ppText(x.t.pct - x.prev.pct)} vs {pctText(x.prev.pct)}</Sub> : null}</>,
    },
    {
      k: "perl", l: "Profit / L", right: true, get: (x) => x.t.perLitre, csv: (x) => (x.t.perLitre == null ? "" : (x.t.perLitre / 100).toFixed(1)),
      cell: (x) => <><Mono>{perL(x.t.perLitre)}</Mono>{x.prev?.perLitre != null && x.t.perLitre != null ? <Sub color={toneOf(x.t.perLitre - x.prev.perLitre)}>{arrow(x.t.perLitre - x.prev.perLitre)}₹{Math.abs((x.t.perLitre - x.prev.perLitre) / 100).toFixed(1)}</Sub> : null}</>,
    },
    { k: "share", l: "Share of sales", right: true, hide: true, get: (x) => x.t.sales, csv: (x) => (total ? ((x.t.sales / total) * 100).toFixed(1) : ""), cell: (x) => <Mono>{total ? `${((x.t.sales / total) * 100).toFixed(1)}%` : "—"}</Mono> },
  ];
}

function lineCols(r: MarginRules): Col[] {
  const L = (x: Row) => x.line!;
  return [
    { k: "order", l: "Order", get: (x) => L(x).orderNo, csv: (x) => String(L(x).orderNo), cell: (x) => <Mono bold>{L(x).orderNo}</Mono> },
    { k: "date", l: "Dispatched", get: (x) => L(x).date, csv: (x) => L(x).date, cell: (x) => <span style={{ whiteSpace: "nowrap" }}>{dayText(L(x).date)}</span> },
    { k: "customer", l: "Customer", get: (x) => L(x).customer, csv: (x) => L(x).customer, cell: (x) => <><span style={{ color: C.ink, fontWeight: 500, whiteSpace: "normal" }}>{L(x).customer}</span><Sub>{L(x).city}</Sub></> },
    { k: "product", l: "Product", get: (x) => L(x).product, csv: (x) => L(x).product, cell: (x) => <span style={{ whiteSpace: "normal" }}>{L(x).product}</span> },
    { k: "cans", l: "Cans", right: true, get: (x) => L(x).cans, csv: (x) => String(L(x).cans), cell: (x) => <Mono>{whole(L(x).cans)}</Mono> },
    { k: "litres", l: "Litres", right: true, get: (x) => L(x).litres, csv: (x) => String(L(x).litres), cell: (x) => <Mono>{litres(L(x).litres)}</Mono> },
    { k: "rate", l: "Rate", right: true, get: (x) => L(x).ratePaise, csv: (x) => (L(x).ratePaise == null ? "" : String(L(x).ratePaise! / 100)), cell: (x) => <Mono>{rs(L(x).ratePaise)}</Mono> },
    { k: "amount", l: "Amount", right: true, get: (x) => L(x).amountPaise, csv: (x) => String(Math.round(L(x).amountPaise / 100)), cell: (x) => <Mono bold>{rs(L(x).amountPaise)}</Mono> },
    {
      k: "lot", l: "Lot · cost", get: (x) => L(x).lotCostPaise, csv: (x) => `${L(x).lots.join(" ")} ${L(x).lotCostPaise == null ? "" : Math.round(L(x).lotCostPaise! / 100)}`,
      cell: (x) => (L(x).lotCostPaise == null ? <Tag tone="warn">NOT ALLOCATED</Tag> : <><Mono color={C.brand}>{L(x).lots.join(", ") || "—"}</Mono><Sub>{rs(L(x).lotCostPaise)}</Sub></>),
    },
    { k: "extra", l: "Extra exp.", right: true, get: (x) => L(x).extraPaise, csv: (x) => String(Math.round(L(x).extraPaise / 100)), cell: (x) => <Mono>{L(x).extraPaise ? rs(L(x).extraPaise) : "—"}</Mono> },
    { k: "discount", l: "Discount", right: true, get: (x) => L(x).discountPaise, csv: (x) => String(Math.round(L(x).discountPaise / 100)), cell: (x) => <Mono>{L(x).discountPaise ? rs(L(x).discountPaise) : "—"}</Mono> },
    { k: "credit", l: "Credit note", right: true, get: (x) => L(x).creditNotePaise, csv: (x) => String(Math.round(L(x).creditNotePaise / 100)), cell: (x) => <Mono>{L(x).creditNotePaise ? rs(L(x).creditNotePaise) : "—"}</Mono> },
    { k: "margin", l: "Gross margin", right: true, get: (x) => L(x).marginPaise, csv: (x) => (L(x).marginPaise == null ? "" : String(Math.round(L(x).marginPaise! / 100))), cell: (x) => (L(x).marginPaise == null ? <span style={{ color: C.warnInk }}>Unknown</span> : <Mono color={C.good} bold>{rs(L(x).marginPaise)}</Mono>) },
    {
      k: "pct", l: "Margin %", get: (x) => linePct(L(x)), csv: (x) => (linePct(L(x)) == null ? "" : linePct(L(x))!.toFixed(1)),
      cell: (x) => <><BandPill pct={linePct(L(x))} band={x.band} />{underFloor(L(x), r) ? <Sub color={C.bad}>floor {r.floorPercent}%</Sub> : null}</>,
    },
    { k: "salesman", l: "Salesman", get: (x) => L(x).salesman, csv: (x) => L(x).salesman, cell: (x) => <span style={{ whiteSpace: "normal" }}>{L(x).salesman}</span> },
    { k: "days", l: "Days", right: true, get: (x) => L(x).days, csv: (x) => String(L(x).days ?? ""), cell: (x) => <Mono color={(L(x).days ?? 0) > 1 ? C.warnInk : C.good}>{L(x).days == null ? "—" : `${L(x).days}d`}</Mono> },
    { k: "formulation", l: "Formulation", hide: true, get: (x) => L(x).formulation, csv: (x) => L(x).formulation, cell: (x) => L(x).formulation },
    { k: "godown", l: "Godown", hide: true, get: (x) => L(x).godown, csv: (x) => L(x).godown, cell: (x) => L(x).godown },
    { k: "state", l: "State", hide: true, get: (x) => L(x).state, csv: (x) => L(x).state, cell: (x) => L(x).state },
  ];
}

function signed(p: number) {
  return <Mono color={toneOf(p)} bold>{`${p >= 0 ? "+" : ""}${rs(p)}`}</Mono>;
}

function bridgeCols(): Col[] {
  const B = (x: Row) => x.bridge!;
  const n = (k: keyof Bridge, l: string): Col => ({ k, l, right: true, get: (x) => B(x)[k], csv: (x) => String(Math.round(B(x)[k] / 100)), cell: (x) => signed(B(x)[k]) });
  return [
    { k: "name", l: "Name", get: (x) => x.title, csv: (x) => x.title, cell: (x) => <span style={{ color: C.ink, fontWeight: 500, whiteSpace: "normal" }}>{x.title}</span> },
    { k: "prevMargin", l: "Margin before", right: true, get: (x) => B(x).prevMargin, csv: (x) => String(Math.round(B(x).prevMargin / 100)), cell: (x) => <Mono>{rs(B(x).prevMargin)}</Mono> },
    n("volume", "Volume"),
    n("price", "Price"),
    n("cost", "Lot cost"),
    n("leakage", "Extra exp. & CN"),
    n("mix", "Mix & other"),
    { k: "margin", l: "Margin now", right: true, get: (x) => B(x).margin, csv: (x) => String(Math.round(B(x).margin / 100)), cell: (x) => <Mono bold>{rs(B(x).margin)}</Mono> },
    { k: "net", l: "Net change", right: true, get: (x) => B(x).margin - B(x).prevMargin, csv: (x) => String(Math.round((B(x).margin - B(x).prevMargin) / 100)), cell: (x) => signed(B(x).margin - B(x).prevMargin) },
  ];
}

function alertCols(): Col[] {
  return [
    {
      k: "title", l: "What", get: (x) => x.title, csv: (x) => x.title,
      cell: (x) => <><span style={{ color: C.ink, fontWeight: 500, whiteSpace: "normal" }}>{x.title}</span><span style={{ display: "block", fontSize: 13, color: C.body, marginTop: 2, whiteSpace: "normal", maxWidth: 640 }}>{x.sub}</span></>,
    },
    { k: "stake", l: "Margin at stake", right: true, get: (x) => x.alert?.stakePaise ?? null, csv: (x) => (x.alert?.stakePaise == null ? "" : String(Math.round(x.alert.stakePaise / 100))), cell: (x) => <Mono color={C.bad} bold>{x.alert?.stakePaise == null ? "—" : rs(x.alert.stakePaise)}</Mono> },
  ];
}

function Tag({ tone, children }: { tone: "bad" | "warn" | "info"; children: React.ReactNode }) {
  const [bg, fg] = tone === "bad" ? [C.badTint, C.bad] : tone === "warn" ? [C.warnTint, C.warnInk] : [C.brandTint, C.brandDark];
  return <span style={{ display: "inline-block", marginLeft: 6, fontSize: 10, fontWeight: 600, letterSpacing: "0.03em", padding: "1px 6px", borderRadius: 4, verticalAlign: 1, background: bg, color: fg }}>{children}</span>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayText(iso: string) {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/* --------------------------------------------------------- saved views */

type SavedView = { id: string; name: string; view: ViewKey; show: string; q: string; facets: Record<string, string[]>; bands: Band[] };

/* ================================================================== desk */

export function MarginsDesk({ period, cur, prev: prevRead, tooWide, cap, rules, rulesHref, initialView }: Props) {
  /* Nothing sold in the span before is no comparison at all, not a comparison with ₹0. */
  const prev = prevRead && prevRead.length ? prevRead : null;
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const [view, setView] = React.useState<ViewKey>(() => (TABS.some((t) => t.views.some((x) => x[0] === initialView)) ? (initialView as ViewKey) : "company"));
  const tab = tabOfView(view);
  const [lastView, setLastView] = React.useState<Partial<Record<TabKey, ViewKey>>>({});
  const [show, setShow] = React.useState("all");
  const [q, setQ] = React.useState("");
  const [facets, setFacets] = React.useState<Record<string, string[]>>({});
  const [bands, setBands] = React.useState<Band[]>([]);
  const [godown, setGodown] = React.useState("all");
  const [sort, setSort] = React.useState<Record<string, [string, 1 | -1]>>({});
  const [group, setGroup] = React.useState<Record<string, string>>({});
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(25);
  const [sel, setSel] = React.useState<Set<string>>(() => new Set());
  const [pop, setPop] = React.useState<null | "filters" | "cols" | "views" | "group" | "custom" | "customise">(null);
  const [open, setOpen] = React.useState<Row | null>(null);
  const [rulesOpen, setRulesOpen] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const [focus, setFocus] = useStored<string[]>("founder.margins.focus", NO_STRINGS);
  const [hidden, setHidden] = useStored<Record<string, string[]>>("founder.margins.cols", NO_HIDDEN);
  const [saved, setSaved] = useStored<SavedView[]>("founder.margins.views", NO_VIEWS);
  const [widgets, setWidgets] = useStored<Record<string, boolean>>("founder.margins.widgets", WIDGETS_DEFAULT);

  const say = React.useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 3200);
  }, []);

  const goView = React.useCallback((v: ViewKey, opts?: { show?: string; keepFilters?: boolean }) => {
    setView(v);
    setLastView((lv) => ({ ...lv, [tabOfView(v)]: v }));
    setShow(opts?.show ?? "all");
    setPage(0);
    setSel(new Set());
    setPop(null);
    if (!opts?.keepFilters) {
      setQ("");
      setBands([]);
    }
    try {
      const u = new URL(window.location.href);
      if (v === "company") u.searchParams.delete("v");
      else u.searchParams.set("v", v);
      window.history.replaceState(null, "", u.toString());
    } catch {
      /* The address simply does not follow. */
    }
  }, []);

  const periodHref = (key: string, from?: string, to?: string) => {
    const u = new URLSearchParams();
    if (key !== "month") u.set("p", key);
    if (key === "custom" && from && to) {
      u.set("from", from);
      u.set("to", to);
    }
    if (view !== "company") u.set("v", view);
    const s = u.toString();
    return `/founder/margins${s ? `?${s}` : ""}`;
  };

  /* Facet filters narrow the LINES, so every roll-up is recomputed for them. */
  const lineFilter = React.useCallback(
    (l: MarginLine) => {
      for (const [k, want] of Object.entries(facets)) {
        if (!want.length) continue;
        if (k === "flags") {
          const f = flagsOf(l, rules);
          if (!want.some((w) => f.includes(w))) return false;
        } else if (!want.includes(String(l[k as keyof MarginLine]))) return false;
      }
      return true;
    },
    [facets, rules],
  );
  const curF = React.useMemo(() => cur.filter(lineFilter), [cur, lineFilter]);
  const prevF = React.useMemo(() => (prev ? prev.filter(lineFilter) : null), [prev, lineFilter]);
  const alerts = React.useMemo(() => marginAlerts(cur, prev, rules, short), [cur, prev, rules]);

  const built = React.useMemo(() => (view === "company" ? null : rowsFor(view, curF, prevF, rules, focus, alerts)), [view, curF, prevF, rules, focus, alerts]);
  const shows = React.useMemo(() => showsFor(view, rules), [view, rules]);
  const showFn = React.useMemo(() => shows.find((s) => s[0] === show)?.[2] ?? (() => true), [shows, show]);
  const totalSales = React.useMemo(() => totals(curF).sales, [curF]);
  const cols: Col[] = React.useMemo(() => {
    if (!built) return [];
    return built.set === "agg" ? aggCols(rules, totalSales) : built.set === "line" ? lineCols(rules) : built.set === "bridge" ? bridgeCols() : alertCols();
  }, [built, rules, totalSales]);
  const colKey = built?.set ?? "agg";
  const hiddenHere = hidden[colKey] ?? cols.filter((c) => c.hide).map((c) => c.k);
  const visible = cols.filter((c) => !hiddenHere.includes(c.k));

  const rows = React.useMemo(() => {
    if (!built) return [];
    const needle = q.trim().toLowerCase();
    let out = built.rows.filter(showFn);
    if (needle) out = out.filter((x) => `${x.title} ${x.sub ?? ""} ${x.line ? `${x.line.orderNo} ${x.line.product} ${x.line.lots.join(" ")} ${x.line.salesman}` : ""}`.toLowerCase().includes(needle));
    if (bands.length) out = out.filter((x) => bands.includes(x.band));
    const s = sort[view] ?? (built.set === "line" ? ["date", -1] : built.set === "bridge" ? ["net", 1] : built.set === "alert" ? ["stake", -1] : ["sales", -1]);
    const col = cols.find((c) => c.k === s[0]);
    if (col) {
      out = [...out].sort((a, b) => {
        const x = col.get(a);
        const y = col.get(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number)) * s[1];
      });
    }
    return out;
  }, [built, showFn, q, bands, sort, view, cols]);

  const currentSort = sort[view] ?? (built?.set === "line" ? ["date", -1] : built?.set === "bridge" ? ["net", 1] : built?.set === "alert" ? ["stake", -1] : ["sales", -1]);
  const filterCount = Object.values(facets).reduce((a, v) => a + v.length, 0) + bands.length;

  /* ---------------------------------------------------------- actions */

  const exportCsv = (list: Row[], name: string) => {
    const head = cols.map((c) => c.l);
    const body = list.map((x) => cols.map((c) => c.csv(x)));
    const text = [head, ...body].map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n");
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `margins-${name}-${period.from}-to-${period.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    say(`Exported ${list.length.toLocaleString("en-IN")} rows`);
  };

  const toggleFocus = (ids: string[], on: boolean) => {
    const next = new Set(focus);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    setFocus([...next]);
    say(on ? `Added ${ids.length} to the focus list` : `Removed ${ids.length} from the focus list`);
  };

  const openAlert = (a: MarginAlert) => {
    const target: ViewKey = a.go.tab === "lines" ? "lines" : a.go.tab === "products" ? "sku" : a.go.tab === "customers" ? "customers" : "company";
    goView(target, { show: a.go.show });
    if (a.go.open) {
      const b = rowsFor(target, cur, prev, rules, focus, alerts).rows.find((x) => x.key.endsWith(`:${a.go.open}`));
      if (b) setOpen(b);
    }
  };

  /* -------------------------------------------------------------- frame */

  const tabsBar = (
    <nav aria-label="Margins" style={{ display: "flex", gap: 4, marginTop: 12, overflowX: "auto" }}>
      {TABS.map((t) => {
        const on = t.key === tab;
        const n = t.key === "overview" ? alerts.length : 0;
        return (
          <button
            key={t.key}
            onClick={() => goView(lastView[t.key] ?? t.views[0]![0])}
            style={{ marginBottom: -1, padding: "8px 12px 10px 12px", border: "none", borderBottom: `2px solid ${on ? C.brand : "transparent"}`, background: "none", fontSize: 14, fontWeight: on ? 500 : 400, color: on ? C.brandDark : C.muted, whiteSpace: "nowrap", cursor: "pointer", display: "inline-flex", gap: 6, alignItems: "center" }}
          >
            {t.label}
            {n ? <span style={{ minWidth: 18, height: 18, padding: "0 6px", borderRadius: 9, fontSize: 11, fontWeight: 600, lineHeight: "18px", background: C.warnTint, color: C.warnInk }}>{n}</span> : null}
          </button>
        );
      })}
    </nav>
  );

  const periodBar = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
        <div style={{ position: "relative", display: "flex", gap: 2, padding: 3, background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, flexWrap: "wrap" }}>
          {period.views.map((p) => {
            const on = p.key === period.key;
            return (
              <button
                key={p.key}
                onClick={() => (p.key === "custom" ? setPop(pop === "custom" ? null : "custom") : startTransition(() => router.push(periodHref(p.key))))}
                style={{ height: 28, padding: "0 10px", border: "none", borderRadius: 4, background: on ? C.brand : "transparent", color: on ? C.white : C.body, fontSize: 13, fontWeight: on ? 500 : 400, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                {p.label}
              </button>
            );
          })}
          {pop === "custom" ? <CustomRange from={period.from} to={period.to} onApply={(f, t) => { setPop(null); startTransition(() => router.push(periodHref("custom", f, t))); }} /> : null}
        </div>
        <Hov onClick={() => setRulesOpen(true)} style={btn} hover={{ background: C.canvas }}>Margin rules</Hov>
      </div>
      <div style={{ fontSize: 13, color: C.body }}>{period.views.find((v) => v.key === period.key)?.dates ?? ""}{prev ? "" : " · nothing to compare"}</div>
    </div>
  );

  return (
    <div className="fcc-root" style={{ display: "contents" }}>
      <TitleBlock crumb="Command Centre · Sell" title="Margins" subtitle="What every sale earned after lot cost, discount, expenses and credit notes" right={periodBar} below={tabsBar} />
      <div style={{ padding: "20px 28px 48px 28px", animation: `fd-fade 160ms ${EASE}`, opacity: pending ? 0.55 : 1, transition: `opacity 120ms ${EASE}` }}>
        {tooWide ? (
          <div style={{ ...card, padding: 28, textAlign: "center", color: C.body }}>
            This period holds {tooWide.toLocaleString("en-IN")} billed lines — more than the {cap.toLocaleString("en-IN")} the desk reads at once. Pick a shorter period.
          </div>
        ) : (
          <>
            {TABS.find((t) => t.key === tab)!.views.length > 1 ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                <span style={upper}>View</span>
                <div style={{ display: "flex", gap: 2, padding: 3, background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, flexWrap: "wrap" }}>
                  {TABS.find((t) => t.key === tab)!.views.map(([k, l]) => {
                    const on = k === view;
                    return (
                      <button key={k} onClick={() => goView(k, { keepFilters: true })} style={{ height: 28, padding: "0 10px", border: "none", borderRadius: 4, background: on ? C.brandTint : "transparent", color: on ? C.brandDark : C.body, fontSize: 13, fontWeight: on ? 500 : 400, cursor: "pointer", whiteSpace: "nowrap" }}>
                        {l}
                        {k === "needs" && alerts.length ? ` (${alerts.length})` : ""}
                      </button>
                    );
                  })}
                </div>
                {view === "company" ? (
                  <>
                    <span style={{ flex: 1 }} />
                    <span style={{ position: "relative" }}>
                      <Hov onClick={() => setPop(pop === "customise" ? null : "customise")} style={btn} hover={{ background: C.canvas }}>Customise</Hov>
                      {pop === "customise" ? (
                        <div style={{ ...popCss, top: 38, right: 0, width: 260, padding: "6px 0" }}>
                          <div style={{ padding: "6px 14px 8px", fontSize: 12, color: C.muted, borderBottom: `1px solid ${C.soft}` }}>What Overview shows, remembered in this browser.</div>
                          {([["tiles", "Figure tiles"], ["waterfall", "From sale to margin"], ["bridge", "Why margin moved"], ["bands", "How the lines are spread"], ["movers", "Biggest movers"], ["salesmen", "Margin by salesman"], ["alerts", "Needs a look"]] as const).map(([k, l]) => (
                            <label key={k} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 14px", fontSize: 14, cursor: "pointer" }}>
                              <input type="checkbox" checked={widgets[k] !== false} onChange={() => setWidgets({ ...widgets, [k]: widgets[k] === false })} style={{ accentColor: C.brand }} />
                              {l}
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}

            {view === "company" ? (
              <Overview cur={cur} prev={prev} rules={rules} alerts={alerts} godown={godown} setGodown={setGodown} widgets={widgets} goView={goView} openAlert={openAlert} openRow={setOpen} openBand={(band) => { setBands([band]); goView("lines", { keepFilters: true }); }} />
            ) : (
              <ListCard
                view={view}
                rows={rows}
                all={built?.rows.length ?? 0}
                cols={visible}
                allCols={cols}
                colKey={colKey}
                hiddenHere={hiddenHere}
                setHidden={(h) => setHidden({ ...hidden, [colKey]: h })}
                shows={shows}
                show={show}
                setShow={(s) => { setShow(s); setPage(0); }}
                q={q}
                setQ={(v) => { setQ(v); setPage(0); }}
                sort={currentSort as [string, 1 | -1]}
                setSort={(k) => setSort({ ...sort, [view]: currentSort[0] === k ? [k, currentSort[1] === 1 ? -1 : 1] : [k, -1] })}
                group={group[view] ?? ""}
                setGroup={(g) => setGroup({ ...group, [view]: g })}
                page={page}
                setPage={setPage}
                size={size}
                setSize={(n) => { setSize(n); setPage(0); }}
                sel={sel}
                setSel={setSel}
                pop={pop}
                setPop={setPop}
                filterCount={filterCount}
                facets={facets}
                setFacets={(f) => { setFacets(f); setPage(0); }}
                bands={bands}
                setBands={(b) => { setBands(b); setPage(0); }}
                cur={cur}
                rules={rules}
                saved={saved}
                saveView={(name) => { setSaved([{ id: `v${saved.length + 1}-${name.length}-${view}`, name, view, show, q, facets, bands }, ...saved]); say(`Saved “${name}”`); }}
                openSaved={(s) => { goView(s.view, { show: s.show, keepFilters: true }); setQ(s.q); setFacets(s.facets); setBands(s.bands); say(`Opened “${s.name}”`); }}
                deleteSaved={(id) => setSaved(saved.filter((s) => s.id !== id))}
                openRow={setOpen}
                openAlert={openAlert}
                exportCsv={(list) => exportCsv(list, view)}
                toggleFocus={toggleFocus}
                hasPrev={!!prev}
              />
            )}
          </>
        )}
      </div>

      {open ? <RecordDrawer row={open} rules={rules} close={() => setOpen(null)} openLine={(l) => setOpen(rowsFor("lines", [l], null, rules, focus, alerts).rows[0]!)} /> : null}
      {rulesOpen ? <RulesDrawer rules={rules} href={rulesHref} close={() => setRulesOpen(false)} /> : null}
      {toast ? (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 40, background: C.ink, color: C.white, padding: "10px 16px", borderRadius: 8, fontSize: 13, boxShadow: "0 8px 24px rgba(22,22,22,0.12)" }}>{toast}</div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- styles */

const card: React.CSSProperties = { background: C.white, border: `1px solid ${C.line}`, borderRadius: 8 };
const btn: React.CSSProperties = { height: 32, padding: "0 12px", display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, fontSize: 13, fontWeight: 500, color: C.body, cursor: "pointer", whiteSpace: "nowrap" };
const btnOn: React.CSSProperties = { ...btn, borderColor: C.brand, background: C.brandTint, color: C.brandDark };
const popCss: React.CSSProperties = { position: "absolute", zIndex: 30, background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(22,22,22,0.12)" };
const chip = (on: boolean): React.CSSProperties => ({ height: 28, padding: "0 10px", borderRadius: 14, border: `1px solid ${on ? C.brand : C.line}`, background: on ? C.brandTint : C.white, color: on ? C.brandDark : C.body, fontSize: 13, fontWeight: on ? 500 : 400, cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 });

function CustomRange({ from, to, onApply }: { from: string; to: string; onApply: (f: string, t: string) => void }) {
  const [f, setF] = React.useState(from);
  const [t, setT] = React.useState(to);
  const bad = !f || !t || t < f;
  return (
    <div style={{ ...popCss, top: 40, right: 0, width: 300, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <span style={{ fontSize: 13, color: C.muted }}>Any start and end date, compared with the equal span before it.</span>
      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ flex: 1, fontSize: 12, color: C.body }}>From<input type="date" value={f} onChange={(e) => setF(e.target.value)} style={{ display: "block", width: "100%", height: 32, border: `1px solid ${C.line}`, borderRadius: 4, padding: "0 6px" }} /></label>
        <label style={{ flex: 1, fontSize: 12, color: C.body }}>To<input type="date" value={t} onChange={(e) => setT(e.target.value)} style={{ display: "block", width: "100%", height: 32, border: `1px solid ${C.line}`, borderRadius: 4, padding: "0 6px" }} /></label>
      </div>
      {f && t && t < f ? <span style={{ fontSize: 12, color: C.bad }}>The end is before the start.</span> : null}
      <button disabled={bad} onClick={() => onApply(f, t)} style={{ height: 32, border: "none", borderRadius: 4, background: bad ? C.soft : C.brand, color: bad ? C.muted : C.white, fontSize: 13, fontWeight: 500, cursor: bad ? "not-allowed" : "pointer" }}>Apply</button>
    </div>
  );
}

/* --------------------------------------------------------------- tiles */

type Tile = { label: string; value: string; sub: React.ReactNode; kind?: "Period" | "Now"; tone?: "bad" | "warn"; onClick?: () => void; on?: boolean };

function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <CardGrid min={176} gap="gap-3" className="mb-4">
      {tiles.map((m) => (
        <Hov
          key={m.label}
          as={m.onClick ? "button" : "div"}
          onClick={m.onClick}
          style={{ display: "flex", flexDirection: "column", minWidth: 0, padding: "14px 16px", background: C.white, border: `1px solid ${m.on ? C.brand : C.line}`, boxShadow: m.on ? `0 0 0 3px ${C.brandTint}` : undefined, borderRadius: 8, cursor: m.onClick ? "pointer" : "default", textAlign: "left" }}
          hover={m.onClick ? { borderColor: C.brand } : undefined}
        >
          <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label}</span>
            <span style={{ fontSize: 11, fontWeight: 500, padding: "1px 7px", borderRadius: 9, flex: "none", background: m.kind === "Now" ? C.soft : C.brandTint, color: m.kind === "Now" ? C.body : C.brandDark }}>{m.kind ?? "Period"}</span>
          </span>
          <span style={{ display: "block", fontSize: 24, lineHeight: "30px", fontWeight: 600, marginTop: 8, letterSpacing: "-0.01em", color: m.tone === "bad" ? C.bad : m.tone === "warn" ? C.warnInk : C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.value}</span>
          <span style={{ display: "block", fontSize: 12, lineHeight: "17px", color: C.muted, marginTop: 4 }}>{m.on ? "Showing only these — tap to show everything" : m.sub}</span>
        </Hov>
      ))}
    </CardGrid>
  );
}

function Delta({ cur, prev, kind }: { cur: number | null; prev: number | null | undefined; kind: "pct" | "pp" | "perl" }) {
  if (cur == null || prev == null) return <>No comparison</>;
  const d = cur - prev;
  const text = kind === "pp" ? ppText(d) : kind === "perl" ? `${arrow(d)}₹${Math.abs(d / 100).toFixed(1)}` : chgText(cur, prev);
  return <span style={{ color: toneOf(d), fontWeight: 600 }}>{text}</span>;
}

/* ------------------------------------------------------------- overview */

function Overview({ cur, prev, rules, alerts, godown, setGodown, widgets, goView, openAlert, openRow, openBand }: {
  cur: MarginLine[]; prev: MarginLine[] | null; rules: MarginRules; alerts: MarginAlert[]; godown: string; setGodown: (g: string) => void;
  widgets: Record<string, boolean>; goView: (v: ViewKey, o?: { show?: string }) => void; openAlert: (a: MarginAlert) => void; openRow: (r: Row) => void; openBand: (b: Band) => void;
}) {
  const godowns = React.useMemo(() => [...new Set(cur.map((l) => l.godown))].sort(), [cur]);
  const c = React.useMemo(() => (godown === "all" ? cur : cur.filter((l) => l.godown === godown)), [cur, godown]);
  const p = React.useMemo(() => (prev ? (godown === "all" ? prev : prev.filter((l) => l.godown === godown)) : null), [prev, godown]);
  const t = totals(c);
  const pt = p ? totals(p) : null;
  const w = (k: string) => widgets[k] !== false;

  if (!cur.length) {
    return <div style={{ ...card, padding: 32, textAlign: "center", color: C.muted }}>No billed line left the godown in this period. Pick a longer period.</div>;
  }

  const wf: [string, number, string, boolean, ViewKey][] = [
    ["Amount", t.amount, C.ink, false, "lines"],
    ["Discount", -t.discount, C.warn, true, "discounts"],
    ["Lot cost", -t.lotCost, C.faint, true, "lots"],
    ["Extra expenses", -t.extra, C.warn, true, "extras"],
    ["Credit notes", -t.creditNote, C.bad, true, "credit"],
  ];
  if (t.noCost) wf.push(["No lot cost (held out)", -(c.filter((l) => l.marginPaise == null).reduce((a, l) => a + salesOf(l) - l.extraPaise - l.creditNotePaise, 0)), C.soft, true, "lots"]);
  wf.push(["Gross margin", t.margin, C.good, false, "sku"]);
  const wfPos = placeSteps(wf.map((x) => [x[1], x[3]] as [number, boolean]));

  const b = p && p.length ? bridge(c, p) : null;
  const bandRows = BAND_ORDER.map((band) => {
    const ls = c.filter((l) => bandOf(linePct(l), rules) === band);
    return { band, n: ls.length, sales: ls.reduce((a, l) => a + salesOf(l), 0) };
  });
  const movers = p
    ? rollup(c, p, (l) => l.product)
        .filter((x) => x.prev?.pct != null && x.t.pct != null && x.t.costedSales > 0)
        .sort((a, z) => Math.abs(z.t.pct! - z.prev!.pct!) - Math.abs(a.t.pct! - a.prev!.pct!))
        .slice(0, 6)
    : [];
  const sm = rollup(c, p, (l) => l.salesman).sort((a, z) => z.t.sales - a.t.sales);

  return (
    <div>
      {alerts.slice(0, 2).map((a) => (
        <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", marginBottom: 12, background: a.tone === "bad" ? C.badTint : a.tone === "warn" ? C.warnTint : C.brandTint, border: `1px solid ${a.tone === "bad" ? C.badTint : a.tone === "warn" ? C.warnLine : C.brandTint2}`, borderRadius: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: a.tone === "bad" ? C.bad : a.tone === "warn" ? C.warn : C.brandDark, flex: "none", display: "block" }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: C.ink }}>{a.title} — {a.body}</span>
          <Hov onClick={() => openAlert(a)} style={btn} hover={{ background: C.canvas }}>Open</Hov>
        </div>
      ))}

      {godowns.length > 1 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <span style={{ ...upper, marginRight: 4 }}>Godown</span>
          {["all", ...godowns].map((g) => (
            <button key={g} onClick={() => setGodown(g)} style={chip(godown === g)}>{g === "all" ? "All godowns" : g}</button>
          ))}
        </div>
      ) : null}

      {w("tiles") ? (
        <Tiles
          tiles={[
            { label: "Sales (excl. GST)", value: short(t.sales), sub: pt ? <>Prev {short(pt.sales)} · <Delta cur={t.sales} prev={pt.sales} kind="pct" /></> : `${t.orders} orders · ${t.customers} customers`, onClick: () => goView("lines") },
            { label: "Gross margin", value: t.costedSales ? short(t.margin) : "—", sub: !t.costedSales ? "No line is costed yet" : pt ? <>Prev {short(pt.margin)} · <Delta cur={t.margin} prev={pt.margin} kind="pct" /></> : "On costed lines", onClick: () => goView("sku") },
            { label: "Margin %", value: pctText(t.pct), sub: pt ? <>Prev {pctText(pt.pct)} · <Delta cur={t.pct} prev={pt.pct} kind="pp" /></> : `Target ${rules.targetPercent}%`, onClick: () => goView("formulation") },
            { label: "Profit per litre", value: perL(t.perLitre), sub: pt ? <>Prev {perL(pt.perLitre)} · <Delta cur={t.perLitre} prev={pt.perLitre} kind="perl" /></> : "Costed litres", onClick: () => goView("sku") },
            { label: "Litres sold", value: litres(t.litres), sub: pt ? <>Prev {litres(pt.litres)} · <Delta cur={t.litres} prev={pt.litres} kind="pct" /></> : `${whole(t.cans)} cans`, onClick: () => goView("lines") },
            { label: "No lot cost", value: whole(t.noCost), kind: "Now", tone: t.noCost ? "warn" : undefined, sub: t.noCost ? `${short(t.noCostSales)} of sales held out` : "Every line is costed", onClick: () => goView("lines", { show: "nocost" }) },
          ]}
        />
      ) : null}

      <CardGrid min="broad" gap="gap-4" className="mb-4">
        {w("waterfall") ? (
          <Panel title="From sale to margin" hint="Every line, before GST · tap a row to open it">
            {wf.map(([label, v, color, , to], i) => {
              const [left, width] = wfPos[i]!;
              const max = t.amount || 1;
              return (
                <Hov key={label} onClick={() => goView(to)} style={rowBtn} hover={{ background: C.canvas }}>
                  <span>{label}</span>
                  <span style={{ height: 16, background: C.canvas, borderRadius: 3, position: "relative", display: "block" }}>
                    <span style={{ position: "absolute", top: 0, bottom: 0, borderRadius: 3, background: color, left: `${(left / max) * 100}%`, width: `${Math.max(0.5, (width / max) * 100)}%` }} />
                  </span>
                  <Mono bold>{rs(v)}</Mono>
                  <span style={{ textAlign: "right", fontSize: 12, color: C.muted }}>{((Math.abs(v) / max) * 100).toFixed(1)}%</span>
                </Hov>
              );
            })}
          </Panel>
        ) : null}
        {w("bridge") ? (
          <Panel title="Why margin moved" hint={b ? "Against the period before" : ""} action={b ? <button onClick={() => goView("cmp-product")} style={linkBtn}>By product →</button> : undefined}>
            {b ? (
              ([["Margin before", "", b.prevMargin, false], ["Volume", "More or fewer costed litres, at the old profit per litre", b.volume, true], ["Price", "The same products sold at a different rate", b.price, true], ["Lot cost", "The same products costed differently", b.cost, true], ["Extra expenses & credit notes", "Against the period before", b.leakage, true], ["Mix & other", "What sold, in what proportion", b.mix, true], ["Margin now", pctText(t.pct), b.margin, false]] as const).map(([l, note, v, step]) => (
                <div key={l} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: `1px solid ${C.canvas}`, fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}><span style={{ color: C.ink, fontWeight: 500 }}>{l}</span>{note ? <Sub>{note}</Sub> : null}</span>
                  {step ? signed(v) : <Mono bold>{rs(v)}</Mono>}
                </div>
              ))
            ) : (
              <div style={{ padding: "24px 0", color: C.muted, fontSize: 14 }}>Nothing was sold in the period before, so there is nothing to compare against.</div>
            )}
          </Panel>
        ) : null}
        {w("bands") ? (
          <Panel title="How the lines are spread" hint="Sales by margin band · bands are set in Margin rules">
            <div style={{ display: "flex", height: 20, borderRadius: 4, overflow: "hidden", background: C.soft }}>
              {bandRows.map((x) => <span key={x.band} title={`${BAND_LABEL[x.band]}: ${rs(x.sales)}`} style={{ display: "block", background: BAND_BAR[x.band], width: `${t.sales ? (x.sales / t.sales) * 100 : 0}%` }} />)}
            </div>
            {bandRows.map((x) => (
              <Hov key={x.band} onClick={() => openBand(x.band)} style={{ ...rowBtn, gridTemplateColumns: "12px minmax(0,1fr) auto 110px" }} hover={{ background: C.canvas }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: BAND_BAR[x.band], display: "block" }} />
                <span>{BAND_LABEL[x.band]} <span style={{ color: C.muted, fontSize: 12 }}>· {bandRange(x.band, rules)}</span></span>
                <span style={{ color: C.muted }}>{whole(x.n)} lines</span>
                <Mono>{rs(x.sales)}</Mono>
              </Hov>
            ))}
          </Panel>
        ) : null}
        {w("movers") ? (
          <Panel title="Biggest movers" hint="Margin % change by product">
            {movers.length ? movers.map((x) => {
              const d = x.t.pct! - x.prev!.pct!;
              return (
                <Hov key={x.key} onClick={() => openRow({ key: `Product:${x.key}`, title: x.key, kind: "Product", lines: x.lines, t: x.t, prev: x.prev, band: bandOf(x.t.pct, rules) })} style={{ ...rowBtn, gridTemplateColumns: "minmax(0,1fr) auto 80px" }} hover={{ background: C.canvas }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.ink }}>{x.key}</span>
                  <span style={{ color: C.muted, fontSize: 12 }}>{pctText(x.prev!.pct)} → {pctText(x.t.pct)}</span>
                  <span style={{ textAlign: "right", fontWeight: 600, color: toneOf(d) }}>{ppText(d)}</span>
                </Hov>
              );
            }) : <div style={{ padding: "24px 0", color: C.muted, fontSize: 14 }}>No product sold in both periods.</div>}
          </Panel>
        ) : null}
        {w("salesmen") ? (
          <Panel title="Margin by salesman" hint={`The line is the ${rules.targetPercent}% target`}>
            {sm.map((x) => (
              <Hov key={x.key} onClick={() => openRow({ key: `Salesman:${x.key}`, title: x.key, kind: "Salesman", lines: x.lines, t: x.t, prev: x.prev, band: bandOf(x.t.pct, rules) })} style={{ ...rowBtn, gridTemplateColumns: "170px minmax(0,1fr) 60px" }} hover={{ background: C.canvas }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.ink }}>{x.key}</span>
                <span style={{ position: "relative", height: 12, background: C.canvas, borderRadius: 3, display: "block" }}>
                  <span style={{ position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 3, background: BAND_BAR[bandOf(x.t.pct, rules)], width: `${Math.max(0, Math.min(100, ((x.t.pct ?? 0) / Math.max(rules.targetPercent * 1.75, 1)) * 100))}%` }} />
                  <span style={{ position: "absolute", top: -3, bottom: -3, left: `${(rules.targetPercent / Math.max(rules.targetPercent * 1.75, 1)) * 100}%`, borderLeft: `2px solid ${C.ink}` }} />
                </span>
                <span style={{ textAlign: "right", fontWeight: 600, color: C.ink }}>{pctText(x.t.pct)}</span>
              </Hov>
            ))}
          </Panel>
        ) : null}
      </CardGrid>

      {w("alerts") ? (
        <Panel title="Needs a look" hint={`${alerts.length} open · read off the lines and the rules`} action={<button onClick={() => goView("needs")} style={linkBtn}>See all →</button>}>
          {alerts.length ? (
            <CardGrid min="panel" gap="gap-2.5">
              {alerts.slice(0, 6).map((a) => (
                <Hov key={a.id} onClick={() => openAlert(a)} style={{ display: "flex", flexDirection: "column", gap: 5, padding: "12px 14px", borderRadius: 8, textAlign: "left", cursor: "pointer", border: `1px solid ${a.tone === "bad" ? C.badTint : a.tone === "warn" ? C.warnLine : C.brandTint2}`, background: a.tone === "bad" ? "#FEF7F7" : a.tone === "warn" ? C.warnTint : "#FAF8FF", color: C.body }} hover={{ borderColor: C.brand }}>
                  <span style={{ fontSize: 14, fontWeight: 500, color: C.ink }}>{a.title}</span>
                  <span style={{ fontSize: 13 }}>{a.body}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: C.brand }}>Open →{a.stakePaise != null ? ` · ${rs(a.stakePaise)} at stake` : ""}</span>
                </Hov>
              ))}
            </CardGrid>
          ) : (
            <div style={{ padding: "16px 0", color: C.muted }}>Nothing needs a look. Every rule is quiet.</div>
          )}
        </Panel>
      ) : null}
    </div>
  );
}

/** Where each bar of a waterfall sits: a step hangs down from the running total, a total stands on zero. */
function placeSteps(steps: [number, boolean][]): [number, number][] {
  let run = 0;
  return steps.map(([v, step], i) => {
    if (i === 0) {
      run = v;
      return [0, v];
    }
    if (!step) return [0, v];
    run += v;
    return [run, -v];
  });
}

const rowBtn: React.CSSProperties = { display: "grid", gridTemplateColumns: "150px minmax(0,1fr) 110px 50px", gap: 10, alignItems: "center", fontSize: 13, background: "none", border: "none", padding: "4px 6px", textAlign: "left", width: "100%", borderRadius: 4, color: C.body, cursor: "pointer" };
const linkBtn: React.CSSProperties = { background: "none", border: "none", padding: 0, color: C.brand, fontWeight: 500, fontSize: 13, cursor: "pointer" };

function Panel({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ ...card, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: C.ink }}>{title}</span>
        {hint ? <span style={{ fontSize: 12, color: C.muted }}>{hint}</span> : null}
        <span style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- list */

type ListProps = {
  view: ViewKey; rows: Row[]; all: number; cols: Col[]; allCols: Col[]; colKey: string; hiddenHere: string[]; setHidden: (h: string[]) => void;
  shows: [string, string, (x: Row) => boolean][]; show: string; setShow: (s: string) => void; q: string; setQ: (q: string) => void;
  sort: [string, 1 | -1]; setSort: (k: string) => void; group: string; setGroup: (g: string) => void;
  page: number; setPage: (n: number) => void; size: number; setSize: (n: number) => void;
  sel: Set<string>; setSel: (s: Set<string>) => void;
  pop: string | null; setPop: (p: null | "filters" | "cols" | "views" | "group" | "custom" | "customise") => void;
  filterCount: number; facets: Record<string, string[]>; setFacets: (f: Record<string, string[]>) => void; bands: Band[]; setBands: (b: Band[]) => void;
  cur: MarginLine[]; rules: MarginRules; saved: SavedView[]; saveView: (name: string) => void; openSaved: (s: SavedView) => void; deleteSaved: (id: string) => void;
  openRow: (r: Row) => void; openAlert: (a: MarginAlert) => void; exportCsv: (rows: Row[]) => void; toggleFocus: (ids: string[], on: boolean) => void; hasPrev: boolean;
};

const GROUPS: Partial<Record<ViewKey, [string, string, (x: Row) => string][]>> = {
  sku: [["formulation", "Formulation", (x) => x.lines[0]?.formulation ?? "—"]],
  customers: [["salesman", "Salesman", (x) => x.lines[0]?.salesman ?? "—"], ["state", "State", (x) => x.lines[0]?.state ?? "—"], ["city", "City", (x) => x.lines[0]?.city ?? "—"]],
  top: [["salesman", "Salesman", (x) => x.lines[0]?.salesman ?? "—"]],
  city: [["state", "State", (x) => x.lines[0]?.state ?? "—"]],
  district: [["state", "State", (x) => x.lines[0]?.state ?? "—"]],
  lines: [["salesman", "Salesman", (x) => x.line?.salesman ?? "—"], ["formulation", "Formulation", (x) => x.line?.formulation ?? "—"], ["godown", "Godown", (x) => x.line?.godown ?? "—"], ["customer", "Customer", (x) => x.line?.customer ?? "—"]],
  discounts: [["salesman", "Salesman", (x) => x.line?.salesman ?? "—"]],
  extras: [["salesman", "Salesman", (x) => x.line?.salesman ?? "—"], ["city", "City", (x) => x.line?.city ?? "—"]],
  credit: [["salesman", "Salesman", (x) => x.line?.salesman ?? "—"]],
};

function ListCard(p: ListProps) {
  const { rows, cols, sel } = p;
  const [saveName, setSaveName] = React.useState("");
  const groups = GROUPS[p.view] ?? [];
  const groupDef = groups.find((g) => g[0] === p.group);
  const pages = Math.max(1, Math.ceil(rows.length / p.size));
  const pg = Math.min(p.page, pages - 1);
  const shown = groupDef ? rows : rows.slice(pg * p.size, pg * p.size + p.size);
  const selRows = rows.filter((x) => sel.has(x.key));
  const selT = totals(selRows.flatMap((x) => x.lines));
  const footT = totals(rows.flatMap((x) => x.lines));
  const allTicked = rows.length > 0 && rows.every((x) => sel.has(x.key));
  const isCustomer = p.view === "customers" || p.view === "top";
  const tpl = `36px ${cols.map((c) => (c.k === "name" || c.k === "customer" || c.k === "product" || c.k === "title" ? "minmax(200px, 2fr)" : "minmax(116px, 1fr)")).join(" ")}`;
  const minW = 36 + cols.reduce((a, c) => a + (c.k === "name" || c.k === "customer" || c.k === "product" || c.k === "title" ? 200 : 116), 0) + cols.length * 12;

  const tickAll = () => p.setSel(allTicked ? new Set() : new Set(rows.map((x) => x.key)));
  const tick = (k: string) => {
    const n = new Set(sel);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    p.setSel(n);
  };

  const rowEl = (x: Row) => (
    <Hov
      as="div"
      key={x.key}
      onClick={() => (x.alert ? p.openAlert(x.alert) : p.openRow(x))}
      style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, alignItems: "start", minWidth: minW, padding: "11px 18px", borderTop: `1px solid ${C.canvas}`, background: sel.has(x.key) ? "#F8F5FF" : C.white, cursor: "pointer", fontSize: 14 }}
      hover={{ background: C.canvas }}
    >
      <span onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`Tick ${x.title}`} checked={sel.has(x.key)} onChange={() => tick(x.key)} style={{ accentColor: C.brand, width: 15, height: 15, cursor: "pointer" }} />
      </span>
      {cols.map((c) => (
        <span key={c.k} style={{ minWidth: 0, textAlign: c.right ? "right" : "left", color: C.ink }}>
          {c.cell(x)}
        </span>
      ))}
    </Hov>
  );

  return (
    <section style={{ ...card, overflow: "visible" }}>
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.soft}`, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: C.ink }}>{TABS.flatMap((t) => t.views).find((v) => v[0] === p.view)?.[1]}</span>
        <span style={{ fontSize: 13, color: C.body }}>{rows.length === p.all ? `${whole(rows.length)} rows` : `${whole(rows.length)} of ${whole(p.all)}`}</span>
        <span style={{ flex: 1 }} />
        <Hov as="input" value={p.q} onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.setQ(e.target.value)} placeholder="Search this list" aria-label="Search this list" style={{ width: 240, height: 32, padding: "0 10px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.canvas, fontSize: 13 }} focus={{ background: C.white, borderColor: C.brand }} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 18px", borderBottom: `1px solid ${C.soft}`, position: "relative" }}>
        {p.shows.length > 1 ? (
          <>
            <span style={upper}>Show</span>
            {p.shows.map(([k, l]) => <button key={k} onClick={() => p.setShow(k)} style={chip(p.show === k)}>{l}</button>)}
          </>
        ) : null}
        <span style={{ flex: 1 }} />
        <span style={{ position: "relative" }}>
          <Hov onClick={() => p.setPop(p.pop === "filters" ? null : "filters")} style={p.filterCount ? btnOn : btn} hover={{ background: C.canvas }}>
            <Icon name="funnel" size={14} /> Filters{p.filterCount ? ` · ${p.filterCount}` : ""}
          </Hov>
          {p.pop === "filters" ? <FilterPop {...p} /> : null}
        </span>
        {groups.length ? (
          <span style={{ position: "relative" }}>
            <Hov onClick={() => p.setPop(p.pop === "group" ? null : "group")} style={p.group ? btnOn : btn} hover={{ background: C.canvas }}>{groupDef ? `By ${groupDef[1].toLowerCase()}` : "Group"}</Hov>
            {p.pop === "group" ? (
              <div style={{ ...popCss, top: 38, right: 0, width: 220, padding: "6px 0" }}>
                {[["", "No grouping"] as const, ...groups.map((g) => [g[0], g[1]] as const)].map(([k, l]) => (
                  <MenuItem key={k} on={p.group === k} onClick={() => { p.setGroup(k); p.setPop(null); }}>{l}</MenuItem>
                ))}
              </div>
            ) : null}
          </span>
        ) : null}
        <span style={{ position: "relative" }}>
          <Hov onClick={() => p.setPop(p.pop === "cols" ? null : "cols")} style={btn} hover={{ background: C.canvas }}>Columns {cols.length}/{p.allCols.length}</Hov>
          {p.pop === "cols" ? (
            <div style={{ ...popCss, top: 38, right: 0, width: 260, padding: "6px 0" }}>
              <div style={{ padding: "6px 14px 8px", fontSize: 12, color: C.muted, borderBottom: `1px solid ${C.soft}` }}>Tick what this list shows. Every column is still searched and exported.</div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {p.allCols.map((c) => {
                  const on = !p.hiddenHere.includes(c.k);
                  return (
                    <label key={c.k} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 14px", fontSize: 14, cursor: "pointer" }}>
                      <input type="checkbox" checked={on} disabled={on && cols.length <= 1} onChange={() => p.setHidden(on ? [...p.hiddenHere, c.k] : p.hiddenHere.filter((h) => h !== c.k))} style={{ accentColor: C.brand }} />
                      {c.l}
                    </label>
                  );
                })}
              </div>
              <div style={{ borderTop: `1px solid ${C.soft}`, padding: "8px 14px" }}>
                <button onClick={() => p.setHidden(p.allCols.filter((c) => c.hide).map((c) => c.k))} style={linkBtn}>Reset to the usual columns</button>
              </div>
            </div>
          ) : null}
        </span>
        <span style={{ position: "relative" }}>
          <Hov onClick={() => p.setPop(p.pop === "views" ? null : "views")} style={btn} hover={{ background: C.canvas }}>Views</Hov>
          {p.pop === "views" ? (
            <div style={{ ...popCss, top: 38, right: 0, width: 320, padding: "6px 0" }}>
              <div style={{ padding: "6px 14px 8px", fontSize: 12, color: C.muted, borderBottom: `1px solid ${C.soft}` }}>A saved view keeps the view, Show, search and filters. Kept in this browser.</div>
              {p.saved.length ? p.saved.map((s) => (
                <div key={s.id} style={{ display: "flex", alignItems: "center" }}>
                  <MenuItem onClick={() => p.openSaved(s)}>{s.name}<Sub>{TABS.flatMap((t) => t.views).find((v) => v[0] === s.view)?.[1]}</Sub></MenuItem>
                  <button aria-label={`Delete ${s.name}`} onClick={() => p.deleteSaved(s.id)} style={{ ...linkBtn, color: C.muted, padding: "0 12px" }}>✕</button>
                </div>
              )) : <div style={{ padding: "10px 14px", fontSize: 13, color: C.muted }}>No saved views yet.</div>}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!saveName.trim()) return;
                  p.saveView(saveName.trim());
                  setSaveName("");
                  p.setPop(null);
                }}
                style={{ display: "flex", gap: 6, padding: "8px 14px", borderTop: `1px solid ${C.soft}` }}
              >
                <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Name this view" aria-label="Name this view" style={{ flex: 1, height: 30, border: `1px solid ${C.line}`, borderRadius: 4, padding: "0 8px", fontSize: 13 }} />
                <button type="submit" disabled={!saveName.trim()} style={{ ...btn, height: 30, background: C.brand, color: C.white, borderColor: C.brand }}>Save</button>
              </form>
            </div>
          ) : null}
        </span>
        <Hov onClick={() => p.exportCsv(rows)} style={btn} hover={{ background: C.canvas }}>Export</Hov>
      </div>

      {p.filterCount ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: "10px 18px", borderBottom: `1px solid ${C.soft}` }}>
          {p.bands.map((b) => <button key={b} onClick={() => p.setBands(p.bands.filter((x) => x !== b))} style={chip(true)}>Band: {BAND_LABEL[b]} ✕</button>)}
          {Object.entries(p.facets).flatMap(([k, vs]) =>
            vs.map((v) => (
              <button key={`${k}:${v}`} onClick={() => p.setFacets({ ...p.facets, [k]: vs.filter((x) => x !== v) })} style={chip(true)}>
                {(FACETS.find((f) => f[0] === k)?.[1] ?? "Flag")}: {v} ✕
              </button>
            )),
          )}
          <button onClick={() => { p.setFacets({}); p.setBands([]); }} style={linkBtn}>Clear all</button>
        </div>
      ) : null}

      {selRows.length ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", background: C.ink, color: C.white, padding: "10px 18px", fontSize: 13 }}>
          <b style={{ fontWeight: 600 }}>{selRows.length} ticked</b>
          <span style={{ color: C.faint }}>{selT.lines ? `Sales ${rs(selT.sales)} · Margin ${rs(selT.margin)} · ${pctText(selT.pct)} · ${litres(selT.litres)}` : ""}</span>
          <span style={{ flex: 1 }} />
          {isCustomer ? (
            <>
              <button onClick={() => p.toggleFocus(selRows.map((x) => x.lines[0]!.customerId), true)} style={darkBtn}>Add to focus list</button>
              <button onClick={() => p.toggleFocus(selRows.map((x) => x.lines[0]!.customerId), false)} style={darkBtn}>Remove from focus</button>
            </>
          ) : null}
          <button onClick={() => p.exportCsv(selRows)} style={darkBtn}>Export ticked</button>
          <button onClick={() => p.setSel(new Set())} style={{ ...linkBtn, color: C.lime }}>Clear</button>
        </div>
      ) : null}

      <div style={{ overflowX: "auto" }}>
        {p.view.startsWith("cmp-") && !p.hasPrev ? (
          <div style={{ padding: "32px 18px", textAlign: "center", fontSize: 14, color: C.muted }}>Nothing was sold in the period before, so there is nothing to compare against.</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, padding: "9px 18px", background: C.canvas, borderBottom: `1px solid ${C.soft}`, minWidth: minW, alignItems: "center" }}>
              <span><input type="checkbox" aria-label="Tick every row" checked={allTicked} onChange={tickAll} style={{ accentColor: C.brand, width: 15, height: 15, cursor: "pointer" }} /></span>
              {cols.map((c) => {
                const on = p.sort[0] === c.k;
                return (
                  <button key={c.k} onClick={() => p.setSort(c.k)} title={`Sort by ${c.l.toLowerCase()}`} aria-pressed={on} style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: on ? C.brandDark : C.muted, textAlign: c.right ? "right" : "left", whiteSpace: "nowrap", background: "none", border: "none", padding: 0, cursor: "pointer" }}>
                    {c.l} <span style={{ opacity: on ? 1 : 0.4 }}>{on ? (p.sort[1] === 1 ? "▲" : "▼") : "↕"}</span>
                  </button>
                );
              })}
            </div>
            {groupDef
              ? Object.entries(
                  shown.reduce<Record<string, Row[]>>((a, x) => {
                    const g = groupDef[2](x);
                    (a[g] ??= []).push(x);
                    return a;
                  }, {}),
                )
                  .sort((a, b) => totals(b[1].flatMap((x) => x.lines)).sales - totals(a[1].flatMap((x) => x.lines)).sales)
                  .map(([g, list]) => {
                    const gt = totals(list.flatMap((x) => x.lines));
                    return (
                      <React.Fragment key={g}>
                        <div style={{ padding: "8px 18px", background: C.soft, fontWeight: 500, color: C.ink, fontSize: 13, minWidth: minW }}>
                          {g} <span style={{ fontWeight: 400, color: C.muted, marginLeft: 8 }}>{list.length} rows · Sales {rs(gt.sales)} · Margin {rs(gt.margin)} · {pctText(gt.pct)}</span>
                        </div>
                        {list.map(rowEl)}
                      </React.Fragment>
                    );
                  })
              : shown.map(rowEl)}
            {rows.length === 0 ? (
              <div style={{ padding: "32px 18px", textAlign: "center", fontSize: 14, color: C.muted }}>
                {p.q || p.filterCount || p.show !== "all" ? "Nothing matches that." : p.view === "needs" ? "Nothing needs a look. Every rule is quiet." : "Nothing in this period."}
              </div>
            ) : footT.lines ? (
              <div style={{ display: "grid", gridTemplateColumns: tpl, gap: 12, padding: "10px 18px", background: C.canvas, borderTop: `1px solid ${C.line}`, minWidth: minW, fontWeight: 600, color: C.ink, fontSize: 13 }}>
                <span />
                {cols.map((c, i) => (
                  <span key={c.k} style={{ textAlign: c.right ? "right" : "left" }}>
                    {i === 0 ? `Total · ${whole(rows.length)}` : c.k === "sales" ? rs(footT.sales) : c.k === "amount" ? rs(footT.amount) : c.k === "margin" ? rs(footT.margin) : c.k === "pct" ? pctText(footT.pct) : c.k === "litres" ? litres(footT.litres) : c.k === "discount" ? rs(footT.discount) : c.k === "extra" ? rs(footT.extra) : c.k === "credit" ? rs(footT.creditNote) : ""}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      {!groupDef && rows.length > 25 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 18px", borderTop: `1px solid ${C.soft}`, flexWrap: "wrap", fontSize: 13, color: C.body }}>
          <span>Showing {whole(pg * p.size + 1)}–{whole(Math.min(rows.length, pg * p.size + p.size))} of {whole(rows.length)}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: C.muted }}>Rows</span>
            {[25, 50, 100].map((z) => <button key={z} onClick={() => p.setSize(z)} style={{ ...chip(p.size === z), height: 26, borderRadius: 4 }}>{z}</button>)}
          </span>
          <span style={{ flex: 1 }} />
          <button disabled={pg <= 0} onClick={() => p.setPage(pg - 1)} style={{ ...btn, height: 28, color: pg > 0 ? C.body : C.faint }}>‹ Previous</button>
          <span>{pg + 1} / {pages}</span>
          <button disabled={pg >= pages - 1} onClick={() => p.setPage(pg + 1)} style={{ ...btn, height: 28, color: pg < pages - 1 ? C.body : C.faint }}>Next ›</button>
        </div>
      ) : null}
    </section>
  );
}

const darkBtn: React.CSSProperties = { height: 28, border: "1px solid #3d3d3d", background: "#2a2a2a", color: C.white, borderRadius: 4, padding: "0 10px", fontSize: 13, cursor: "pointer" };

function MenuItem({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Hov onClick={onClick} style={{ display: "block", flex: 1, width: "100%", padding: "8px 14px", border: "none", background: C.white, textAlign: "left", fontSize: 14, color: on ? C.brandDark : C.body, fontWeight: on ? 500 : 400, cursor: "pointer" }} hover={{ background: C.canvas }}>
      {on ? "✓ " : ""}
      {children}
    </Hov>
  );
}

function FilterPop(p: ListProps) {
  const [f, setF] = React.useState<Record<string, string[]>>(p.facets);
  const [b, setB] = React.useState<Band[]>(p.bands);
  const counts = React.useMemo(() => {
    const out: Record<string, Map<string, number>> = {};
    for (const [k] of FACETS) out[k] = new Map();
    out.flags = new Map();
    for (const l of p.cur) {
      for (const [k] of FACETS) {
        const v = String(l[k]);
        out[k]!.set(v, (out[k]!.get(v) ?? 0) + 1);
      }
      for (const fl of flagsOf(l, p.rules)) out.flags!.set(fl, (out.flags!.get(fl) ?? 0) + 1);
    }
    return out;
  }, [p.cur, p.rules]);
  const toggle = (k: string, v: string) => {
    const now = f[k] ?? [];
    setF({ ...f, [k]: now.includes(v) ? now.filter((x) => x !== v) : [...now, v] });
  };
  const sections: [string, string, string[]][] = [
    ...FACETS.map(([k, l]) => [k as string, l, [...counts[k]!.entries()].sort((x, y) => y[1] - x[1]).map((e) => e[0])] as [string, string, string[]]),
    ["flags", "Flags", FLAGS.filter((x) => counts.flags!.has(x))],
  ];
  return (
    <div role="dialog" aria-label="Filters" style={{ ...popCss, top: 38, right: 0, width: "min(480px, 92vw)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px 12px" }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: C.ink }}>Filters</span>
        <span style={{ fontSize: 12, color: C.muted }}>Narrow the lines; every total is worked out again for them.</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => { setF({}); setB([]); }} style={linkBtn}>Clear all</button>
      </div>
      <div style={{ maxHeight: "min(460px, 60vh)", overflowY: "auto" }}>
        <FilterSection title="Margin band">
          {BAND_ORDER.map((band) => <button key={band} onClick={() => setB(b.includes(band) ? b.filter((x) => x !== band) : [...b, band])} style={chip(b.includes(band))}>{BAND_LABEL[band]}</button>)}
        </FilterSection>
        {sections.filter((s) => s[2].length > 1 || s[0] === "flags").map(([k, l, values]) => (
          <FilterSection key={k} title={l} aside={(f[k] ?? []).length ? `${(f[k] ?? []).length} picked` : "any"}>
            {values.slice(0, 40).map((v) => (
              <button key={v} onClick={() => toggle(k, v)} style={chip((f[k] ?? []).includes(v))}>
                {v} <span style={{ color: (f[k] ?? []).includes(v) ? C.brand : C.muted }}>{counts[k]?.get(v) ?? 0}</span>
              </button>
            ))}
            {values.length > 40 ? <span style={{ fontSize: 12, color: C.muted }}>and {values.length - 40} more — search the list for them</span> : null}
          </FilterSection>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: `1px solid ${C.line}`, background: C.canvas, padding: "12px 18px", borderRadius: "0 0 8px 8px" }}>
        <span style={{ fontSize: 12, color: C.muted }}>Counts are lines in the period.</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => p.setPop(null)} style={btn}>Cancel</button>
        <button onClick={() => { p.setFacets(Object.fromEntries(Object.entries(f).filter(([, v]) => v.length))); p.setBands(b); p.setPop(null); }} style={{ ...btn, background: C.brand, borderColor: C.brand, color: C.white }}>Apply</button>
      </div>
    </div>
  );
}

function FilterSection({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${C.soft}`, padding: "12px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span style={{ fontWeight: 600, color: C.ink }}>{title}</span>
        {aside ? <span style={{ color: C.muted }}>{aside}</span> : null}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

/* --------------------------------------------------------------- drawers */

function Drawer({ close, width, children }: { close: () => void; width: number; children: React.ReactNode }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 20, background: "rgba(22,22,22,0.35)", display: "flex", justifyContent: "flex-end", animation: `fd-fade 150ms ${EASE}` }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width, maxWidth: "calc(100vw - 48px)", height: "100%", background: C.white, boxShadow: "0 8px 24px rgba(22,22,22,0.12)", display: "flex", flexDirection: "column", animation: `fd-drawer 200ms ${EASE}` }}>
        {children}
      </div>
    </div>
  );
}

function DrawerHead({ kind, title, sub, close }: { kind: string; title: string; sub?: React.ReactNode; close: () => void }) {
  return (
    <div style={{ flex: "none", padding: "18px 22px", borderBottom: `1px solid ${C.soft}`, display: "flex", alignItems: "flex-start", gap: 12 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", ...upper, fontSize: 12 }}>{kind}</span>
        <span style={{ display: "block", fontSize: 20, fontWeight: 600, color: C.ink, marginTop: 2 }}>{title}</span>
        {sub ? <span style={{ display: "block", fontSize: 14, color: C.muted, marginTop: 2 }}>{sub}</span> : null}
      </span>
      <button onClick={close} aria-label="Close" style={{ width: 32, height: 32, border: `1px solid ${C.line}`, background: C.white, borderRadius: 4, cursor: "pointer", color: C.muted, fontSize: 16 }}>✕</button>
    </div>
  );
}

function RecordDrawer({ row, rules, close, openLine }: { row: Row; rules: MarginRules; close: () => void; openLine: (l: MarginLine) => void }) {
  const t = row.t;
  const pv = row.prev;
  const ls = [...row.lines].sort((a, b) => b.date.localeCompare(a.date));
  const steps: [string, number, string][] = [
    ["Amount", t.amount, C.ink],
    ["Discount", -t.discount, C.warn],
    ["Lot cost", -t.lotCost, C.faint],
    ["Extra expenses", -t.extra, C.warn],
    ["Credit notes", -t.creditNote, C.bad],
  ];
  const held = row.lines.filter((l) => l.marginPaise == null).reduce((a, l) => a + salesOf(l) - l.extraPaise - l.creditNotePaise, 0);
  if (held) steps.push(["No lot cost (held out)", -held, C.soft]);
  steps.push(["Gross margin", t.margin, C.good]);
  const pos = placeSteps(steps.map((x, i) => [x[1], i > 0 && i < steps.length - 1] as [number, boolean]));
  const l1 = row.line;
  return (
    <Drawer close={close} width={760}>
      <DrawerHead
        kind={row.kind}
        title={row.title}
        sub={l1 ? `${l1.product} · dispatched ${dayText(l1.date)} · ${l1.salesman}` : row.sub}
        close={close}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
        <Tiles
          tiles={[
            { label: "Sales", value: short(t.sales), sub: pv ? <>Prev {short(pv.sales)} · <Delta cur={t.sales} prev={pv.sales} kind="pct" /></> : `${whole(t.orders)} orders` },
            { label: "Gross margin", value: t.costedSales ? short(t.margin) : "—", sub: !t.costedSales ? "No line is costed yet" : pv ? <>Prev {short(pv.margin)} · <Delta cur={t.margin} prev={pv.margin} kind="pct" /></> : "Costed lines" },
            { label: "Margin %", value: pctText(t.pct), sub: pv ? <>Prev {pctText(pv.pct)} · <Delta cur={t.pct} prev={pv.pct} kind="pp" /></> : BAND_LABEL[bandOf(t.pct, rules)] },
            { label: "Profit / L", value: perL(t.perLitre), sub: litres(t.litres) },
          ]}
        />
        <div>
          <div style={{ ...upper, marginBottom: 8 }}>From sale to margin</div>
          {steps.map(([label, v, color], i) => {
            const [left, width] = pos[i]!;
            const max = t.amount || 1;
            return (
              <div key={label} style={{ ...rowBtn, cursor: "default" }}>
                <span>{label}</span>
                <span style={{ height: 14, background: C.canvas, borderRadius: 3, position: "relative", display: "block" }}>
                  <span style={{ position: "absolute", top: 0, bottom: 0, borderRadius: 3, background: color, left: `${(left / max) * 100}%`, width: `${Math.max(0.5, (width / max) * 100)}%` }} />
                </span>
                <Mono bold>{rs(v)}</Mono>
                <span style={{ textAlign: "right", fontSize: 12, color: C.muted }}>{((Math.abs(v) / max) * 100).toFixed(1)}%</span>
              </div>
            );
          })}
          <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8, background: C.canvas, border: `1px solid ${C.soft}`, fontSize: 13 }}>
            Lot cost is the cost of the lots the dispatch desk allocated to the line, from the purchase register and the packing batch. A line with no lot allocated is held out of margin until one is.
          </div>
        </div>
        {row.bridge ? (
          <div>
            <div style={{ ...upper, marginBottom: 8 }}>Why it moved</div>
            {([["Margin before", row.bridge.prevMargin], ["Volume", row.bridge.volume], ["Price", row.bridge.price], ["Lot cost", row.bridge.cost], ["Extra expenses & credit notes", row.bridge.leakage], ["Mix & other", row.bridge.mix], ["Margin now", row.bridge.margin]] as const).map(([l, v], i) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.canvas}`, fontSize: 13 }}>
                <span>{l}</span>
                {i === 0 || i === 6 ? <Mono bold>{rs(v)}</Mono> : signed(v)}
              </div>
            ))}
          </div>
        ) : null}
        {l1 ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "12px 20px" }}>
            {([["Order", String(l1.orderNo)], ["Customer", l1.customer], ["Cans", whole(l1.cans)], ["Litres", litres(l1.litres)], ["Rate", rs(l1.ratePaise)], ["Lots", l1.lots.join(", ") || "Not allocated"], ["Formulation", l1.formulation], ["Godown", l1.godown], ["Place", `${l1.city}, ${l1.state}`], ["Days to dispatch", l1.days == null ? "—" : `${l1.days}`]] as const).map(([k, v]) => (
              <div key={k}><div style={upper}>{k}</div><div style={{ fontSize: 14, color: C.ink, marginTop: 3 }}>{v}</div></div>
            ))}
          </div>
        ) : (
          <div>
            <div style={{ ...upper, marginBottom: 8 }}>Lines ({whole(ls.length)}){ls.length > 200 ? " · newest 200" : ""}</div>
            <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
              {ls.slice(0, 200).map((l, i) => (
                <Hov key={l.id} as="div" onClick={() => openLine(l)} style={{ display: "grid", gridTemplateColumns: "70px 60px minmax(0,1.4fr) minmax(0,1.4fr) 100px 90px", gap: 10, padding: "8px 12px", borderTop: i ? `1px solid ${C.canvas}` : "none", fontSize: 13, cursor: "pointer", alignItems: "center" }} hover={{ background: C.canvas }}>
                  <Mono bold>{l.orderNo}</Mono>
                  <span>{dayText(l.date)}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.customer}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.product}</span>
                  <span style={{ textAlign: "right" }}><Mono>{rs(salesOf(l))}</Mono></span>
                  <BandPill pct={linePct(l)} band={bandOf(linePct(l), rules)} />
                </Hov>
              ))}
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function RulesDrawer({ rules, href, close }: { rules: MarginRules; href: string | null; close: () => void }) {
  const items: [string, string, string][] = [
    ["Healthy from", `${rules.healthyAtOrAbove}%`, "Drawn green."],
    ["Fair from", `${rules.fairAtOrAbove}%`, "Drawn blue, up to the healthy line."],
    ["Thin from", `${rules.thinAtOrAbove}%`, "Drawn amber. Below it is red."],
    ["Floor", `${rules.floorPercent}%`, "A line under it is raised in Needs a look."],
    ["Company target", `${rules.targetPercent}%`, "What the company and each salesman are measured against."],
    ["Product drop worth an alert", `${rules.productDropPoints} pp`, "Against the period before."],
    ["Customer fall worth an alert", `${rules.customerDropPercent}%`, "Margin ₹ of the twenty largest customers."],
  ];
  return (
    <Drawer close={close} width={560}>
      <DrawerHead kind="Margins · applies to every sub-tab" title="Margin rules" sub="How margin is worked out, and how it is banded and alerted." close={close} />
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ padding: "12px 14px", borderRadius: 8, background: C.canvas, border: `1px solid ${C.soft}`, fontSize: 14, lineHeight: "21px" }}>
          <b style={{ color: C.ink, fontWeight: 600 }}>Gross margin</b> = amount − discount − lot cost − extra expenses − credit notes, before GST — the ERP&apos;s own margin on the line. Margin % is taken over sales after discount. A line whose lot is not allocated is held out of margin and margin %, never counted as 100%.
        </div>
        {items.map(([k, v, note]) => (
          <div key={k} style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "8px 0", borderBottom: `1px solid ${C.canvas}` }}>
            <span style={{ flex: 1 }}><span style={{ color: C.ink, fontWeight: 500 }}>{k}</span><Sub>{note}</Sub></span>
            <Mono bold>{v}</Mono>
          </div>
        ))}
        {href ? (
          <a href={href} style={{ ...btn, alignSelf: "flex-start", background: C.brand, borderColor: C.brand, color: C.white, textDecoration: "none" }}>Change them in Settings</a>
        ) : (
          <span style={{ fontSize: 13, color: C.muted }}>The founder changes these in the Admin Console, under Settings → Reports → Margins.</span>
        )}
      </div>
    </Drawer>
  );
}
