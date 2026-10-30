import { addDays } from "../business-date";

/* ---------------------------------------------------------------------------
 * WATCH THE MONEY — every order line against the price that was live on its
 * own date, grouped so the money given away below the book can be read.
 *
 * PURE. The lines arrive already judged (`varianceRowsForRange` resolves each
 * against the revision in force on its date, versions included); this file
 * only decides what "below" costs, who took a line, whether somebody approved
 * the difference, and how the lines add up. No clock: the day is passed in.
 *
 * MONEY GIVEN AWAY is (book − billed) × cans, ex-GST, over lines billed BELOW
 * the book only. A line with no can count is counted as one can, exactly as
 * the month's variance report counts it, so the two screens agree.
 * ------------------------------------------------------------------------- */

export type WatchSource = "sheet" | "erp";

export type WatchLine = {
  lineId: string;
  orderDate: string;
  orderNumber: string | null;
  customerId: string | null;
  customerName: string;
  productId: string | null;
  productName: string;
  cans: number | null;
  billedExPaise: number;
  listExPaise: number | null;
  listInclPaise: number | null;
  listGstBp: number | null;
  listId: string | null;
  listName: string | null;
  deltaPaise: number | null;
  deltaBp: number | null;
  sheetDiscountBp: number | null;
  source: WatchSource;
  takenByName: string | null;
  takenById: string | null;
  rateSetById: string | null;
  rateSetByName: string | null;
  discountAuthorisedById: string | null;
  discountAuthorisedByName: string | null;
};

export type WatchVerdict = "on" | "below" | "above" | "unpriced";

/**
 * Why a difference below the book may have been meant. `authorised` — the ERP
 * recorded who saved the discount; `override` — a special price for this shop
 * and product covered the line's date; `approved_request` — a special price
 * was asked for and approved; `asked` — one was asked for and is still waiting.
 */
export type WatchApproval = "authorised" | "override" | "approved_request" | "asked";

export const APPROVAL_LABEL: Record<WatchApproval, string> = {
  authorised: "Discount authorised in the ERP",
  override: "Special price on record",
  approved_request: "Special price approved",
  asked: "Special price asked for",
};

/** What the record holds that could explain a lower price, per shop × product. */
export type WatchApprovalFacts = {
  overrides: Array<{ customerId: string; productId: string; validFrom: string; validTo: string | null }>;
  requests: Array<{ customerId: string; productId: string; status: string; day: string }>;
};

export function verdictOf(line: Pick<WatchLine, "listExPaise" | "deltaPaise">): WatchVerdict {
  if (line.listExPaise == null || line.deltaPaise == null) return "unpriced";
  if (line.deltaPaise < 0) return "below";
  if (line.deltaPaise > 0) return "above";
  return "on";
}

export function cansOf(line: Pick<WatchLine, "cans">): number {
  return line.cans == null ? 1 : Number(line.cans);
}

/** (book − billed) × cans over a line billed below the book; zero otherwise. */
export function givenAwayPaise(line: Pick<WatchLine, "listExPaise" | "deltaPaise" | "cans">): number {
  if (verdictOf(line) !== "below") return 0;
  return Math.abs(line.deltaPaise ?? 0) * cansOf(line);
}

export type WatchPerson = { key: string; name: string; known: boolean };

/**
 * WHO TOOK THE LINE, as far as the record says. An ERP line names whoever
 * typed a rate other than the list's first — that is the person who chose the
 * price — and the account that created it after. A sheet line names its
 * salesman as typed. Nothing is guessed: no name is "Not recorded".
 */
export function personOf(line: Pick<WatchLine, "source" | "takenById" | "takenByName" | "rateSetById" | "rateSetByName">): WatchPerson {
  const id = line.rateSetById ?? line.takenById;
  const name = (line.rateSetById ? line.rateSetByName : line.takenByName)?.trim() || line.takenByName?.trim() || null;
  if (id) return { key: `user:${id}`, name: name ?? "Unnamed account", known: true };
  if (name) return { key: `name:${name.toLowerCase().replace(/\s+/g, " ")}`, name, known: true };
  return { key: "unknown", name: "Not recorded", known: false };
}

export function approvalOf(
  line: Pick<WatchLine, "customerId" | "productId" | "orderDate" | "discountAuthorisedById">,
  facts: WatchApprovalFacts,
): WatchApproval | null {
  if (line.discountAuthorisedById) return "authorised";
  if (!line.customerId || !line.productId) return null;
  const covered = facts.overrides.some(
    (o) =>
      o.customerId === line.customerId &&
      o.productId === line.productId &&
      o.validFrom <= line.orderDate &&
      (o.validTo == null || o.validTo >= line.orderDate),
  );
  if (covered) return "override";
  const asks = facts.requests.filter((r) => r.customerId === line.customerId && r.productId === line.productId);
  if (asks.some((r) => r.status === "approved")) return "approved_request";
  if (asks.some((r) => r.status === "pending")) return "asked";
  return null;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const uniq = <T,>(xs: Iterable<T>) => [...new Set(xs)];

export type WatchTotals = {
  lines: number;
  priced: number;
  on: number;
  below: number;
  above: number;
  unpriced: number;
  givenAwayPaise: number;
  /** Of the money given away, how much has nothing on record approving it. */
  unapprovedPaise: number;
};

export type WatchShopProduct = {
  key: string;
  customerId: string | null;
  customerName: string;
  productId: string | null;
  productName: string;
  /** The book price on the NEWEST below line — a revision may sit inside the range. */
  listExPaise: number | null;
  listInclPaise: number | null;
  listGstBp: number | null;
  /** Every distinct book price the lines were judged against. */
  listPrices: number[];
  billedMinPaise: number;
  billedMedianPaise: number;
  billedMaxPaise: number;
  lines: number;
  cans: number;
  givenAwayPaise: number;
  unapprovedPaise: number;
  listNames: string[];
  sources: WatchSource[];
  people: string[];
  approvals: WatchApproval[];
  /** Indices into `WatchReport.lines`, newest first. */
  lineIdx: number[];
};

export type WatchPersonGroup = {
  key: string;
  name: string;
  known: boolean;
  sources: WatchSource[];
  lines: number;
  belowLines: number;
  cans: number;
  givenAwayPaise: number;
  unapprovedPaise: number;
  shops: number;
  products: number;
  lineIdx: number[];
};

export type WatchProductGroup = {
  key: string;
  productId: string | null;
  productName: string;
  lines: number;
  belowLines: number;
  cans: number;
  givenAwayPaise: number;
  unapprovedPaise: number;
  shops: number;
  medianDeltaBp: number | null;
  lineIdx: number[];
};

export type WatchLineView = WatchLine & {
  verdict: WatchVerdict;
  givenAwayPaise: number;
  person: WatchPerson;
  approval: WatchApproval | null;
};

export type WatchReport = {
  totals: WatchTotals;
  lines: WatchLineView[];
  byShopProduct: WatchShopProduct[];
  byPerson: WatchPersonGroup[];
  byProduct: WatchProductGroup[];
};

/** Every line judged, then added up three ways. Groups are money first. */
export function buildWatch(input: readonly WatchLine[], facts: WatchApprovalFacts): WatchReport {
  const lines: WatchLineView[] = input.map((l) => {
    const verdict = verdictOf(l);
    return {
      ...l,
      verdict,
      givenAwayPaise: givenAwayPaise(l),
      person: personOf(l),
      approval: verdict === "below" ? approvalOf(l, facts) : null,
    };
  });

  const totals: WatchTotals = {
    lines: lines.length,
    priced: 0,
    on: 0,
    below: 0,
    above: 0,
    unpriced: 0,
    givenAwayPaise: 0,
    unapprovedPaise: 0,
  };
  for (const l of lines) {
    totals[l.verdict] += 1;
    if (l.verdict !== "unpriced") totals.priced += 1;
    totals.givenAwayPaise += l.givenAwayPaise;
    if (!l.approval) totals.unapprovedPaise += l.givenAwayPaise;
  }

  // Newest first inside every group.
  const order = lines.map((_, i) => i).sort((a, b) => (lines[b].orderDate < lines[a].orderDate ? -1 : lines[b].orderDate > lines[a].orderDate ? 1 : b - a));

  const shopMap = new Map<string, number[]>();
  const personMap = new Map<string, number[]>();
  const productMap = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, i: number) => {
    const arr = m.get(k);
    if (arr) arr.push(i);
    else m.set(k, [i]);
  };
  for (const i of order) {
    const l = lines[i];
    if (l.verdict === "below") {
      const k = `${l.customerId ?? `n:${l.customerName}`}|${l.productId ?? `n:${l.productName}`}`;
      push(shopMap, k, i);
    }
    if (l.verdict !== "unpriced") {
      push(personMap, l.person.key, i);
      const pk = l.productId ?? `n:${l.productName}`;
      push(productMap, pk, i);
    }
  }

  const sum = (idx: number[], f: (l: WatchLineView) => number) => idx.reduce((s, i) => s + f(lines[i]), 0);
  const shopKey = (l: WatchLineView) => l.customerId ?? `n:${l.customerName}`;

  const byShopProduct: WatchShopProduct[] = [...shopMap.entries()].map(([key, idx]) => {
    const first = lines[idx[0]];
    const billed = idx.map((i) => lines[i].billedExPaise);
    return {
      key,
      customerId: first.customerId,
      customerName: first.customerName,
      productId: first.productId,
      productName: first.productName,
      listExPaise: first.listExPaise,
      listInclPaise: first.listInclPaise,
      listGstBp: first.listGstBp,
      listPrices: uniq(idx.map((i) => lines[i].listExPaise).filter((p): p is number => p != null)),
      billedMinPaise: Math.min(...billed),
      billedMedianPaise: median(billed) ?? 0,
      billedMaxPaise: Math.max(...billed),
      lines: idx.length,
      cans: sum(idx, cansOf),
      givenAwayPaise: sum(idx, (l) => l.givenAwayPaise),
      unapprovedPaise: sum(idx, (l) => (l.approval ? 0 : l.givenAwayPaise)),
      listNames: uniq(idx.map((i) => lines[i].listName).filter((n): n is string => !!n)),
      sources: uniq(idx.map((i) => lines[i].source)),
      people: uniq(idx.map((i) => lines[i].person.name)),
      approvals: uniq(idx.map((i) => lines[i].approval).filter((a): a is WatchApproval => !!a)),
      lineIdx: idx,
    };
  });

  const byPerson: WatchPersonGroup[] = [...personMap.entries()].map(([key, idx]) => {
    const below = idx.filter((i) => lines[i].verdict === "below");
    return {
      key,
      name: lines[idx[0]].person.name,
      known: lines[idx[0]].person.known,
      sources: uniq(idx.map((i) => lines[i].source)),
      lines: idx.length,
      belowLines: below.length,
      cans: sum(below, cansOf),
      givenAwayPaise: sum(below, (l) => l.givenAwayPaise),
      unapprovedPaise: sum(below, (l) => (l.approval ? 0 : l.givenAwayPaise)),
      shops: new Set(below.map((i) => shopKey(lines[i]))).size,
      products: new Set(below.map((i) => lines[i].productId ?? lines[i].productName)).size,
      lineIdx: below,
    };
  });

  const byProduct: WatchProductGroup[] = [...productMap.entries()].map(([key, idx]) => {
    const below = idx.filter((i) => lines[i].verdict === "below");
    return {
      key,
      productId: lines[idx[0]].productId,
      productName: lines[idx[0]].productName,
      lines: idx.length,
      belowLines: below.length,
      cans: sum(below, cansOf),
      givenAwayPaise: sum(below, (l) => l.givenAwayPaise),
      unapprovedPaise: sum(below, (l) => (l.approval ? 0 : l.givenAwayPaise)),
      shops: new Set(below.map((i) => shopKey(lines[i]))).size,
      medianDeltaBp: median(below.map((i) => lines[i].deltaBp).filter((b): b is number => b != null)),
      lineIdx: below,
    };
  });

  const byMoney = <T extends { givenAwayPaise: number; lines: number }>(a: T, b: T) =>
    b.givenAwayPaise - a.givenAwayPaise || b.lines - a.lines;
  byShopProduct.sort(byMoney);
  byPerson.sort(byMoney);
  byProduct.sort(byMoney);

  return { totals, lines, byShopProduct, byPerson, byProduct };
}

/* ------------------------------------------------------------------ range */

export const WATCH_PRESETS = ["7d", "30d", "month", "last_month", "custom"] as const;
export type WatchPreset = (typeof WATCH_PRESETS)[number];

export const WATCH_PRESET_LABEL: Record<WatchPreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  last_month: "Last month",
  custom: "Custom",
};

/**
 * THE WINDOW, read off the URL. `from` and `to` are BOTH INCLUSIVE as a person
 * picks and reads them ("1 Oct to 15 Oct"); `toExclusive` is the day after
 * `to`, which is what the query is asked with. A custom range with a missing
 * or backwards date falls back to the last 30 days rather than reporting an
 * empty window nobody meant.
 */
export function watchRange(
  input: { preset?: string | null; from?: string | null; to?: string | null },
  today: string,
): { preset: WatchPreset; from: string; to: string; toExclusive: string } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const preset = (WATCH_PRESETS as readonly string[]).includes(input.preset ?? "") ? (input.preset as WatchPreset) : "30d";
  const make = (p: WatchPreset, from: string, to: string) => ({ preset: p, from, to, toExclusive: addDays(to, 1) });
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "7d":
      return make("7d", addDays(today, -6), today);
    case "month":
      return make("month", monthStart, today);
    case "last_month": {
      const lastEnd = addDays(monthStart, -1);
      return make("last_month", `${lastEnd.slice(0, 7)}-01`, lastEnd);
    }
    case "custom": {
      const from = input.from ?? "";
      const to = input.to ?? "";
      if (iso.test(from) && iso.test(to) && from <= to) return make("custom", from, to);
      return make("30d", addDays(today, -29), today);
    }
    default:
      return make("30d", addDays(today, -29), today);
  }
}
