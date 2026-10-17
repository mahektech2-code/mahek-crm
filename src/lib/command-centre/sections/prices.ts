import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { decidePriceRequest } from "@/lib/actions/price-lists";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/format";
import { today } from "@/lib/recompute";
import { DELIVERY_BASIS_LABEL, FREIGHT_TERM_LABEL, LIST_STATUS_LABEL, SCOPE_KIND_LABEL } from "@/lib/price-list-labels";
import type { PriceListSummary, RequestView, VarianceReport } from "@/lib/price-list-views";
import {
  coverageReport,
  listPriceLists,
  listRequests,
  priceListDetail,
  pricingCounts,
  varianceReport,
} from "@/lib/services/price-list-service";
import {
  auditFor,
  emptyPage,
  fromOwning,
  notesFor,
  refusal,
  slice,
  stampIST,
  withPage,
  type Ctx,
  type SectionProvider,
  type TableQuery,
} from "../provider";
import { crore, fmtDate, fmtDay, inr, monthLabel, monthLong, num, plural } from "../format";
import type { ActSpec, Cell, FigureDrawer, Metric, RecordView, Row, TableDef, TablePage, Tone } from "../types";

/* ---------------------------------------------------------------------------
 * PRICE LISTS — PRD §17, the design's `prices` section.
 *
 * Read through the Founder desk's own service (`price-list-service.ts`):
 * `listPriceLists`, `listRequests`, `coverageReport`, `varianceReport`,
 * `pricingCounts`. Approving and refusing a special price is the desk's own
 * `decidePriceRequest`, so a decision here is the decision there.
 *
 * Money is shown WITH GST. The lists and the sheet store rates ex-GST, so a
 * rate is carried up by the GST of the list it sits on — the same arithmetic
 * `listRequests` already does for the asked rate.
 * ------------------------------------------------------------------------- */

const SECTION = "Price lists";
const n = (v: unknown) => Number(v ?? 0);
const incl = (ex: number, gstBp: number) => Math.round(ex * (1 + gstBp / 10_000));
const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
/** A stored instant's calendar day in IST, "2026-09-22". */
const istDay = (iso: string) => IST_DAY.format(new Date(iso));

/* ------------------------------------------------------------ table defs */

const REQUEST_ACTS: ActSpec[] = [
  {
    key: "approve",
    label: "Approve",
    confirm: "The shop is charged the asked rate on its next order, until the list is replaced.",
    done: "Approved",
  },
  {
    key: "refuse",
    label: "Refuse",
    tone: "bad",
    confirm: "The telecaller is told, with your reason, and must ring the shop back.",
    done: "Refused",
    form: {
      title: "Refuse this special price",
      submit: "Refuse",
      consequence: "The telecaller is told, with your reason, and must ring the shop back.",
      fields: [
        {
          k: "reason",
          label: "Why is it being refused?",
          type: "area",
          req: true,
          ph: "Below what we can supply this pack at",
          hint: "It goes to the person who asked, word for word.",
        },
      ],
    },
  },
];

const DEFS: Record<"requests" | "lists", TableDef> = {
  requests: {
    key: "requests",
    title: "Special price requests",
    hint: "Now · decide each one",
    noun: "request",
    rec: "Special price request",
    acts: REQUEST_ACTS,
    cols: [
      ["Customer", "1.5fr"],
      ["Product", "1.5fr"],
      ["Asked", "0.8fr", true],
      ["List", "0.8fr", true],
      ["Gap", "0.7fr", true],
      ["Raised by", "1fr"],
    ],
  },
  lists: {
    key: "lists",
    title: "Lists",
    hint: "Now",
    noun: "list",
    rec: "Price list",
    cols: [
      ["List", "1.6fr"],
      ["Applies to", "1.4fr"],
      ["Shops", "0.6fr", true],
      ["Expires", "0.8fr"],
      ["State", "0.9fr"],
    ],
  },
};

/* ------------------------------------------------------------ reads */

async function gstOf(listIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(listIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.execute<{ id: string; gst_bp: number }>(sql`
    select price_lists.id, price_lists.gst_bp from price_lists
     where price_lists.id in (${sql.join(
       ids.map((i) => sql`${i}`),
       sql`, `,
     )})
  `);
  return new Map(rows.map((r) => [r.id, n(r.gst_bp)]));
}

async function cityOf(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: customers.id, city: customers.city })
    .from(customers)
    .where(inArray(customers.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.city ?? ""]));
}

/** Sold below list for a month, WITH GST: each line's shortfall × cans, carried up by its list's GST. */
async function belowList(month: string): Promise<{ report: VarianceReport; paise: number; lines: number; gst: Map<string, number>; fallback: number }> {
  const [report, config] = await Promise.all([varianceReport(month), getConfig()]);
  const fallback = config["pricing.gstBp"];
  const below = report.rows.filter((r) => r.listExPaise != null && (r.deltaPaise ?? 0) < 0);
  const gst = await gstOf(below.map((r) => r.listId ?? ""));
  const paise = below.reduce(
    (s, r) => s + incl(Math.abs(r.deltaPaise ?? 0) * (r.cans ?? 1), gst.get(r.listId ?? "") ?? fallback),
    0,
  );
  return { report, paise, lines: below.length, gst, fallback };
}

/** When a published list stops, in days from today. Null when open-ended. */
function daysToExpiry(l: PriceListSummary, day: string): number | null {
  if (!l.expiresOn) return null;
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${l.expiresOn}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function expiringSoon(l: PriceListSummary, day: string): boolean {
  if (l.status !== "published") return false;
  const d = daysToExpiry(l, day);
  return d != null && d >= 0 && d <= 7;
}

/* -------------------------------------------------------- requests table */

function gapBp(r: RequestView): number | null {
  if (r.currentRateExGstPaise == null || r.currentRateExGstPaise <= 0) return null;
  return Math.round(((r.requestedRateExGstPaise - r.currentRateExGstPaise) / r.currentRateExGstPaise) * 10_000);
}

function gapCell(bp: number | null, managerMaxBp: number): Cell {
  if (bp == null) return { t: "No list rate", pill: "muted" };
  const t = `${bp < 0 ? "−" : bp > 0 ? "+" : ""}${(Math.abs(bp) / 100).toFixed(1)}%`;
  const pill: Tone = bp >= 0 ? "good" : -bp > managerMaxBp ? "bad" : "warn";
  return { t, pill };
}

async function requestRows(all: RequestView[]): Promise<{ rows: Row[]; managerMaxBp: number }> {
  const [config, cities, gst] = await Promise.all([
    getConfig(),
    cityOf(all.map((r) => r.customerId)),
    gstOf(all.map((r) => r.currentListId ?? "")),
  ]);
  const managerMaxBp = config["pricing.managerMaxDiscountBp"];
  const defaultGst = config["pricing.gstBp"];
  return {
    managerMaxBp,
    rows: all.map((r) => ({
      id: r.id,
      cells: [
        { t: r.customerName, sub: cities.get(r.customerId) || undefined },
        { t: r.productName },
        { t: inr(r.requestedRateInclGstPaise) },
        {
          t:
            r.currentRateExGstPaise == null
              ? "—"
              : inr(incl(r.currentRateExGstPaise, gst.get(r.currentListId ?? "") ?? defaultGst)),
        },
        gapCell(gapBp(r), managerMaxBp),
        { t: r.requestedByName, sub: fmtDay(istDay(r.requestedAt)).replace(/^0/, "") },
      ],
    })),
  };
}

async function requestsPage(query: TableQuery): Promise<TablePage> {
  const all = await listRequests({ status: "pending" });
  const s = slice(all, query, (r, q) =>
    [r.customerName, r.productName, r.requestedByName, r.reason].join(" ").toLowerCase().includes(q),
  );
  const { rows } = await requestRows(s.rows);
  return { rows, count: s.count, total: s.total, page: s.page, size: query.size, q: query.q };
}

/* ----------------------------------------------------------- lists table */

async function scopeWords(listIds: string[]): Promise<Map<string, string>> {
  if (!listIds.length) return new Map();
  const rows = await db.execute<{ id: string; kind: keyof typeof SCOPE_KIND_LABEL; label: string | null; value: string }>(sql`
    select price_list_scopes.price_list_id as id, price_list_scopes.scope_kind as kind,
           price_list_scopes.scope_label as label, price_list_scopes.scope_value as value
      from price_list_scopes
     where price_list_scopes.price_list_id in (${sql.join(
       listIds.map((i) => sql`${i}`),
       sql`, `,
     )})
     order by price_list_scopes.priority desc, price_list_scopes.scope_kind
  `);
  const by = new Map<string, string[]>();
  for (const r of rows) {
    const words =
      r.kind === "everybody" ? "Everybody" : `${SCOPE_KIND_LABEL[r.kind] ?? "Scope"} · ${r.label ?? r.value}`;
    by.set(r.id, [...(by.get(r.id) ?? []), words]);
  }
  return new Map(
    [...by].map(([id, w]) => [id, w.slice(0, 2).join(", ") + (w.length > 2 ? ` +${w.length - 2}` : "")]),
  );
}

function stateCell(l: PriceListSummary, day: string): Cell {
  if (l.status === "draft") return { t: "Draft", pill: "muted" };
  if (l.status !== "published") return { t: LIST_STATUS_LABEL[l.status], pill: "muted" };
  if (l.expired) return { t: "Expired", pill: "bad" };
  if (expiringSoon(l, day)) return { t: "Expiring", pill: "warn" };
  return { t: "Published", pill: "good" };
}

/** The lists that are live or being prepared: published first (expiring at the top), then drafts. */
async function currentLists(q: string): Promise<PriceListSummary[]> {
  const all = await listPriceLists({ status: "all", q: q.trim().length >= 2 ? q : undefined });
  const day = await today();
  const rank = (l: PriceListSummary) =>
    l.status === "published" ? (l.expired ? 0 : expiringSoon(l, day) ? 1 : 2) : 3;
  return all
    .filter((l) => l.status === "published" || l.status === "draft")
    .sort((a, b) => rank(a) - rank(b) || (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999") || a.name.localeCompare(b.name));
}

async function listsPage(query: TableQuery, perList?: Map<string, number>): Promise<TablePage> {
  const [matched, everything, day] = await Promise.all([
    currentLists(query.q),
    query.q.trim().length >= 2 ? currentLists("") : Promise.resolve(null),
    today(),
  ]);
  const s = slice(matched, { ...query, q: "" }, () => true);
  const shops =
    perList ??
    new Map((await coverageReport(day)).perList.map((p) => [p.listId, p.customers] as [string, number]));
  const words = await scopeWords(s.rows.map((l) => l.id));
  return {
    rows: s.rows.map((l) => ({
      id: l.id,
      cells: [
        { t: l.name, sub: [l.refNo, `v${l.version}`].filter(Boolean).join(" · ") },
        { t: words.get(l.id) ?? "Nobody yet" },
        { t: l.status === "published" ? num(shops.get(l.id) ?? 0) : "—" },
        { t: l.status === "published" && l.expiresOn ? fmtDay(l.expiresOn).replace(/^0/, "") : l.status === "published" ? "No end date" : "—" },
        stateCell(l, day),
      ],
    })),
    count: matched.length,
    total: (everything ?? matched).length,
    page: s.page,
    size: query.size,
    q: query.q,
  };
}

/* ---------------------------------------------------------------- section */

async function section(ctx: Ctx) {
  const day = ctx.period.today;
  const q: TableQuery = { q: "", page: 1, size: 25 };
  const [counts, coverage, lists, below, requests] = await Promise.all([
    pricingCounts(),
    coverageReport(day),
    currentLists(""),
    belowList(ctx.period.monthKey),
    requestsPage(q),
  ]);
  const perList = new Map(coverage.perList.map((p) => [p.listId, p.customers] as [string, number]));
  const listPage = await listsPage(q, perList);

  const expiring = lists
    .filter((l) => expiringSoon(l, day))
    .sort((a, b) => (a.expiresOn ?? "").localeCompare(b.expiresOn ?? ""));
  const isThisMonth = ctx.period.monthKey === day.slice(0, 7);

  const metrics: Metric[] = [
    {
      key: "published",
      label: "Published lists",
      value: num(counts.published),
      sub: counts.published ? `price ${num(coverage.resolved)} shops` : "no list is published yet",
      kind: "Now",
    },
    {
      key: "requests",
      label: "Special requests",
      value: num(counts.requestsPending),
      sub: counts.requestsPending ? "waiting on you" : "nothing waiting on you",
      kind: "Now",
      tone: counts.requestsPending ? "bad" : undefined,
    },
    {
      key: "expiring",
      label: "Expiring in 7 days",
      value: num(expiring.length),
      sub:
        expiring.length === 0
          ? "no published list ends this week"
          : expiring.length === 1
            ? `${expiring[0].name} · ${fmtDay(expiring[0].expiresOn).replace(/^0/, "")}`
            : `${expiring[0].name} first · ${fmtDay(expiring[0].expiresOn).replace(/^0/, "")}`,
      kind: "Now",
      tone: expiring.length ? "warn" : undefined,
    },
    {
      key: "no-list",
      label: "On no list",
      value: num(coverage.unresolved),
      sub: "shops with no list rate",
      kind: "Now",
      tone: coverage.unresolved ? "warn" : undefined,
    },
    {
      key: "below",
      label: "Sold below list",
      value: below.paise ? crore(below.paise) : "None",
      sub: isThisMonth ? "given away this month" : `given away in ${monthLong(ctx.period.monthKey)}`,
      kind: "Month",
      tone: below.paise ? "bad" : undefined,
    },
  ];

  return {
    metrics,
    callouts: [],
    tables: [withPage(DEFS.requests, requests), withPage(DEFS.lists, listPage)],
    foot: "Narrowest scope wins: customer, then salesman, beat, area, city, district, state, customer type, everybody. A published list cannot be repriced — publish a new version.",
  };
}

async function tablePage(ctx: Ctx, table: string, query: TableQuery): Promise<TablePage> {
  if (table === "requests") return requestsPage(query);
  if (table === "lists") return listsPage(query);
  return emptyPage(query);
}

/* ---------------------------------------------------------------- figure */

function last12Months(monthKey: string): string[] {
  const out: string[] = [];
  let y = Number(monthKey.slice(0, 4));
  let m = Number(monthKey.slice(5, 7));
  for (let i = 0; i < 12; i++) {
    out.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

async function figure(ctx: Ctx, metric: string): Promise<FigureDrawer> {
  const day = ctx.period.today;
  const asOf = stampIST(new Date());
  const scope = { label: "Scope", value: "Company-wide · every customer" };
  const noBars = { bars: [], barsLabel: "No history is kept for this figure" };
  const now = (title: string, value: string) => ({ kind: "Now figure · Price lists", title, value });

  if (metric === "published" || metric === "expiring") {
    const [lists, coverage] = await Promise.all([currentLists(""), coverageReport(day)]);
    const shops = new Map(coverage.perList.map((p) => [p.listId, p.customers] as [string, number]));
    const published = lists.filter((l) => l.status === "published");
    const picked = metric === "expiring" ? published.filter((l) => expiringSoon(l, day)) : published;
    return {
      ...now(metric === "expiring" ? "Expiring in 7 days" : "Published lists", num(picked.length)),
      facts: [
        { label: "Kind", value: "Now" },
        { label: "As of", value: asOf },
        {
          label: "Basis",
          value:
            metric === "expiring"
              ? `Published lists whose validity ends by ${fmtDate(addDays(day, 7))}`
              : `${plural(coverage.resolved, "shop")} priced by a list · ${plural(coverage.unresolved, "shop")} on none`,
        },
        scope,
        { label: "Source", value: "Price lists and their scopes" },
      ],
      def:
        metric === "expiring"
          ? "Published lists that stop applying within the next seven days — the earlier of their validity and any list that replaces them. After that the shops they price fall through to a wider list, or to none."
          : "Price lists currently published. A shop is priced by the narrowest published list whose scope names it; drafts price nobody.",
      ...noBars,
      rowsLabel: metric === "expiring" ? "Ending soonest" : "Lists pricing the most shops",
      rows: (metric === "expiring"
        ? picked
        : [...picked].sort((a, b) => (shops.get(b.id) ?? 0) - (shops.get(a.id) ?? 0))
      )
        .slice(0, 8)
        .map((l) => ({
          a: l.name,
          b: l.expiresOn ? `Ends ${fmtDate(l.expiresOn)}` : "No end date",
          c: plural(shops.get(l.id) ?? 0, "shop"),
        })),
      noRowsLine: picked.length ? undefined : metric === "expiring" ? "No published list ends this week." : "No list is published yet.",
      section: "prices",
    };
  }

  if (metric === "requests") {
    const all = await listRequests({ status: "pending" });
    return {
      ...now("Special requests", num(all.length)),
      facts: [
        { label: "Kind", value: "Now" },
        { label: "As of", value: asOf },
        { label: "Basis", value: "Asked rates with GST, against the shop's list today" },
        scope,
        { label: "Source", value: "Special price requests" },
      ],
      def: "Special price requests raised from a customer’s record and not yet decided.",
      ...noBars,
      rowsLabel: "Waiting on you",
      rows: all.slice(0, 8).map((r) => ({
        a: r.customerName,
        b: `${r.productName} · ${r.requestedByName}`,
        c: inr(r.requestedRateInclGstPaise),
      })),
      noRowsLine: all.length ? undefined : "Nothing is waiting on you.",
      section: "prices",
    };
  }

  if (metric === "no-list") {
    const coverage = await coverageReport(day);
    return {
      ...now("On no list", num(coverage.unresolved)),
      facts: [
        { label: "Kind", value: "Now" },
        { label: "As of", value: asOf },
        { label: "Basis", value: `Of ${plural(coverage.customersConsidered, "active customer")}, ${num(coverage.resolved)} are priced by a list` },
        scope,
        { label: "Source", value: "Customers, against every published list's scope" },
      ],
      def: "Active customers (not leads, not deactivated) that no published list's scope names today, so an order for them has no list rate to be checked against.",
      ...noBars,
      rowsLabel: "Shops with no list rate",
      rows: coverage.unresolvedCustomers.slice(0, 8).map((c) => ({
        a: c.name,
        b: [c.city, c.region].filter(Boolean).join(" · ") || "No place recorded",
        c: c.salesmanName ?? "No salesman",
      })),
      noRowsLine: coverage.unresolved ? undefined : "Every active shop is priced by a list.",
      sectionLabel: "See coverage on the price lists desk",
    };
  }

  if (metric === "below") {
    const months = last12Months(ctx.period.monthKey);
    const hist = await Promise.all(months.map((m) => belowList(m)));
    const cur = hist[hist.length - 1];
    const worst = cur.report.rows
      .filter((r) => r.listExPaise != null && (r.deltaPaise ?? 0) < 0)
      .map((r) => ({ r, given: incl(Math.abs(r.deltaPaise ?? 0) * (r.cans ?? 1), cur.gst.get(r.listId ?? "") ?? cur.fallback) }))
      .sort((a, b) => b.given - a.given)
      .slice(0, 8);
    return {
      kind: "Month figure · Price lists",
      title: "Sold below list",
      value: cur.paise ? crore(cur.paise) : "None",
      facts: [
        { label: "Kind", value: "Month" },
        { label: "Month", value: monthLabel(ctx.period.monthKey) },
        {
          label: "Basis",
          value: `With GST · ${plural(cur.lines, "order line")} below list, of ${plural(cur.report.summary.lines, "line")} billed · ${num(cur.report.summary.unresolved)} with no list rate to compare`,
        },
        scope,
        { label: "Source", value: "The order sheet's billed rate, against the list that applied on the order date" },
        { label: "As of", value: asOf },
      ],
      def: "For every order line billed in the month, the list rate that applied to that shop on the order date minus the rate billed, times the cans, carried up by the list's GST. Only lines billed below list count; lines with no list rate are left out and counted.",
      bars: hist.map((h, i) => ({
        h: h.paise,
        tip: `${monthLabel(months[i])} · ${h.paise ? crore(h.paise) : "₹0"}`,
        current: i === hist.length - 1 ? true : undefined,
      })),
      barsLabel: "Given away below list, month by month",
      rowsLabel: "The largest gaps this month",
      rows: worst.map(({ r, given }) => ({
        a: r.customerName,
        b: `${r.productName} · ${fmtDate(r.orderDate)}`,
        c: inr(given),
      })),
      noRowsLine: worst.length ? undefined : "Nothing was billed below its list rate this month.",
      sectionLabel: "See variance on the price lists desk",
    };
  }

  throw new Error("There is no figure by that name in Price lists.");
}

/* ---------------------------------------------------------------- record */

const REQUEST_STATUS: Record<RequestView["status"], string> = {
  pending: "Waiting on a decision",
  approved: "Approved",
  refused: "Refused",
  withdrawn: "Withdrawn by the person who asked",
};

async function record(ctx: Ctx, table: string, id: string): Promise<RecordView> {
  if (table === "requests") {
    const all = await listRequests({ status: "all" });
    const r = all.find((x) => x.id === id);
    if (!r) throw new Error("That request no longer exists.");
    const [config, gst, cities, notes, audit] = await Promise.all([
      getConfig(),
      gstOf([r.currentListId ?? ""]),
      cityOf([r.customerId]),
      notesFor("price_request", id),
      auditFor("price_request", id),
    ]);
    const listIncl =
      r.currentRateExGstPaise == null
        ? null
        : incl(r.currentRateExGstPaise, gst.get(r.currentListId ?? "") ?? config["pricing.gstBp"]);
    const gap = gapCell(gapBp(r), config["pricing.managerMaxDiscountBp"]);
    const timeline = [...notes];
    if (r.decidedAt)
      timeline.push({
        what: `${REQUEST_STATUS[r.status]} by ${r.decidedByName ?? "somebody"}${r.decisionNote ? ` — ${r.decisionNote}` : ""}`,
        when: stampIST(r.decidedAt),
      });
    timeline.push({ what: `Asked for by ${r.requestedByName}`, when: stampIST(r.requestedAt) });
    const city = cities.get(r.customerId);
    return {
      kind: `Special price request · ${SECTION}`,
      title: `${r.customerName} · ${r.productName}`,
      sub: `Asked ${inr(r.requestedRateInclGstPaise)} against ${listIncl == null ? "no list rate" : inr(listIncl)} · ${REQUEST_STATUS[r.status]}`,
      fields: [
        { label: "Customer", value: city ? `${r.customerName}, ${city}` : r.customerName },
        { label: "Product", value: r.productName },
        { label: "Asked (with GST)", value: `${inr(r.requestedRateInclGstPaise)} a can` },
        { label: "Asked (excl. GST)", value: `${inr(r.requestedRateExGstPaise)} a can` },
        { label: "List rate (with GST)", value: listIncl == null ? "The shop has no list rate for this" : `${inr(listIncl)} a can` },
        { label: "Their list", value: r.currentListName ?? "None" },
        { label: "Gap", value: gap.t },
        { label: "Why they want it", value: r.reason || "No reason given" },
        { label: "Raised by", value: `${r.requestedByName} · ${stampIST(r.requestedAt)}` },
        { label: "State", value: REQUEST_STATUS[r.status] },
        ...(r.decisionNote ? [{ label: "Decision note", value: r.decisionNote }] : []),
      ],
      timeline,
      audit,
      acts: r.status === "pending" ? REQUEST_ACTS : [],
      href: { label: "Open the request on the price lists desk", url: "/founder/price-lists/requests" },
      noteTarget: { kind: "price_request", id },
    };
  }

  if (table === "lists") {
    const detail = await priceListDetail(id);
    if (!detail) throw new Error("That list no longer exists.");
    const l = detail.list;
    const day = ctx.period.today;
    const [coverage, notes, audit] = await Promise.all([
      l.status === "published" ? coverageReport(day) : Promise.resolve(null),
      notesFor("price_list", id),
      auditFor("price_list", id),
    ]);
    const shops = coverage?.perList.find((p) => p.listId === id)?.customers ?? null;
    const state = stateCell(l, day).t;
    const timeline = [...notes];
    if (l.publishedAt) timeline.push({ what: `Published${l.publishedByName ? ` by ${l.publishedByName}` : ""}`, when: stampIST(l.publishedAt) });
    timeline.push({ what: `Created${l.createdByName ? ` by ${l.createdByName}` : ""}`, when: stampIST(l.createdAt) });
    return {
      kind: `Price list · ${SECTION}`,
      title: l.name,
      sub: [l.refNo, `version ${l.version}`, state].filter(Boolean).join(" · "),
      fields: [
        { label: "State", value: state },
        { label: "Reference", value: l.refNo ?? "None" },
        { label: "Version", value: String(l.version) },
        {
          label: "Applies to",
          value: detail.scopes.length
            ? detail.scopes
                .map((s) => (s.scopeKind === "everybody" ? "Everybody" : `${SCOPE_KIND_LABEL[s.scopeKind]} · ${s.scopeLabel ?? s.scopeValue}`))
                .join(", ")
            : "Nobody yet",
        },
        { label: "Shops it prices today", value: shops == null ? "None — only a published list prices anybody" : num(shops) },
        { label: "Takes effect", value: fmtDate(l.effectiveFrom) },
        { label: "Expires", value: l.expiresOn ? fmtDate(l.expiresOn) : "No end date" },
        { label: "Rates", value: plural(l.rateCount, "rate") },
        { label: "Prices are", value: l.taxBasis === "inclusive" ? `Including GST at ${(l.gstBp / 100).toFixed(0)}%` : `Excluding GST, ${(l.gstBp / 100).toFixed(0)}% added` },
        { label: "Freight", value: FREIGHT_TERM_LABEL[l.freightTerm] },
        ...(l.deliveryBasis ? [{ label: "Delivery basis", value: DELIVERY_BASIS_LABEL[l.deliveryBasis] }] : []),
        ...(detail.parent ? [{ label: "Derived from", value: detail.parent.name }] : []),
        ...(detail.discountTerms.length ? [{ label: "Discount terms", value: detail.discountTerms.map((t) => t.sentence).join(" · ") }] : []),
        ...(l.withdrawReason ? [{ label: "Why it was withdrawn", value: l.withdrawReason }] : []),
        ...(l.notes ? [{ label: "Notes", value: l.notes }] : []),
      ],
      timeline,
      audit,
      acts: [],
      href: { label: "Open the list on the price lists desk", url: `/founder/price-lists/${id}` },
      noteTarget: { kind: "price_list", id },
    };
  }

  throw new Error("There is no such list in Price lists.");
}

/* ------------------------------------------------------------------- act */

/** The owning action's refusal, or our own one-line success (its sentence would repeat ours). */
function owned(r: { ok: boolean }, message: string) {
  return r.ok ? { ok: true as const, message } : fromOwning(r, message);
}


async function act(ctx: Ctx, table: string, key: string, id: string, input: Record<string, string>) {
  try {
    if (table !== "requests") return { ok: false as const, error: "That action is not offered here." };
    const [r] = await db.execute<{ customer: string; product: string }>(sql`
      select customers.name as customer, products.name as product
        from price_requests
        join customers on customers.id = price_requests.customer_id
        join products on products.id = price_requests.product_id
       where price_requests.id = ${id}
    `);
    if (!r) return { ok: false as const, error: "That request no longer exists." };
    const subject = `${r.customer} · ${r.product}`;
    if (key === "approve") return owned(await decidePriceRequest(id, { decision: "approved" }), `Approved · ${subject}`);
    if (key === "refuse") {
      const reason = (input.reason ?? "").trim();
      if (!reason)
        return {
          ok: false as const,
          error: "Say why it is being refused — the telecaller has to ring the shop back with it.",
          fieldErrors: { reason: "A reason is required." },
        };
      return owned(await decidePriceRequest(id, { decision: "refused", note: reason }), `Refused · ${subject}`);
    }
    return { ok: false as const, error: "That action is not offered here." };
  } catch (e) {
    return refusal(e);
  }
}

export const provider: SectionProvider = { section, tablePage, figure, record, act };
