import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { addDays, APP_TIMEZONE } from "@/lib/business-date";
import { canFor, resolveScope } from "@/lib/access-control";
import { resolvePriceList } from "@/lib/engines/price-resolution";
import {
  byMoneyAtStake,
  morningCheck,
  MORNING_KIND_LABEL,
  MORNING_KINDS,
  withoutDismissed,
  type MorningKind,
  type MorningList,
  type MorningOverride,
} from "@/lib/engines/price-morning-check";
import {
  activeScopesAndLists,
  coverageReport,
  geographyOf,
  LIST_SELECT,
  resolveOptionsFrom,
  rowsForLists,
  toSummary,
  varianceForRange,
  type ListRow,
} from "@/lib/services/price-list-service";
import { changeRatesOf, listBooks, volumeFor } from "@/lib/services/price-book-service";
import type { NeedRow, PriceDeskToday, TodayFinding, WeekEvent } from "@/components/pricing/today/types";

/* ---------------------------------------------------------------------------
 * PRICE DESK · TODAY — the morning check, and the screen that reads it.
 *
 * THE MORNING CHECK is written, not computed on every load: it reads every
 * live revision's rates, every override in force and last month's cans, and
 * that is too much to repeat on each visit to a screen. So the nightly (and
 * "Run now") writes the day's findings into `price_book_findings`, and Today
 * reads them back beside the live counts.
 *
 * IT IS NOT NARROWED TO A READER. It runs as a job with nobody signed in, and
 * a broken price is broken for everybody; the screen that shows it is the
 * Price Desk's. The live counts beside it ARE narrowed where a person's book
 * matters (billed below price reads the variance report, which narrows itself).
 *
 * A DISMISSAL HOLDS FOR THE DAY. Re-running deletes and rewrites the day's
 * UNDISMISSED findings of the kinds it computes and never writes one whose key
 * somebody already dismissed for that day — tomorrow's run asks again.
 * ------------------------------------------------------------------------- */

const ISO_TS = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);

type LiveList = MorningList & { effectiveFrom: string };

/** Every book's revision in force on `day`, with what the check needs — no reader scope. */
async function liveLists(day: string): Promise<LiveList[]> {
  const config = await getConfig();
  const opts = resolveOptionsFrom(config);
  const rows = await db.execute<ListRow & { kind: string; derived: boolean }>(sql`
    select x.*, l2.kind, (l2.parent_list_id is not null and l2.derivation is not null) as derived
      from (${LIST_SELECT}) x
      join price_lists l2 on l2.id = x.id
     where x.status = 'published'
     order by x."bookId" asc, x."effectiveFrom" desc, x.version desc, x.id asc
  `);
  const scheduledChanges = new Set(
    [
      ...(await db.execute<{ bookId: string }>(sql`
        select distinct book_id as "bookId" from price_changes where status = 'approved' and go_live > ${day}::date
      `)),
    ].map((r) => r.bookId),
  );
  const byBook = new Map<string, Array<{ row: ListRow & { kind: string; derived: boolean }; summary: ReturnType<typeof toSummary> }>>();
  for (const row of rows) {
    const summary = toSummary(row, day, opts);
    byBook.set(summary.bookId, [...(byBook.get(summary.bookId) ?? []), { row, summary }]);
  }
  const out: Omit<LiveList, "rates">[] = [];
  for (const [bookId, versions] of byBook) {
    const live = versions.find(
      (v) => v.summary.effectiveFrom <= day && (v.summary.effectiveTo == null || v.summary.effectiveTo >= day),
    );
    if (!live) continue;
    const hasScheduled = scheduledChanges.has(bookId) || versions.some((v) => v.summary.effectiveFrom > day);
    out.push({
      listId: live.summary.id,
      bookId,
      name: live.summary.name,
      kind: live.row.kind === "agreed" ? "agreed" : "standard",
      gstBp: live.summary.gstBp,
      derived: !!live.row.derived,
      expiresOn: live.summary.expiresOn,
      hasScheduled,
      scopeCount: live.summary.scopeCount,
      effectiveFrom: live.summary.effectiveFrom,
    });
  }
  const withRates: LiveList[] = [];
  for (const l of out) withRates.push({ ...l, rates: await changeRatesOf(l.listId) });
  return withRates;
}

/** Overrides in force on `day`, with last month's cans and what the shop's book charges without them. */
async function liveOverrides(day: string): Promise<MorningOverride[]> {
  const rows = await db.execute<{
    id: string;
    customerId: string;
    customerName: string;
    productId: string;
    productName: string;
    rateExGstPaise: string | number;
    validTo: string | null;
    minCansPerMonth: number | null;
    agreedListId: string | null;
    agreedBookId: string | null;
  }>(sql`
    select o.id, o.customer_id as "customerId", c.name as "customerName", o.product_id as "productId", p.name as "productName",
           o.rate_ex_gst_paise as "rateExGstPaise", o.valid_to::text as "validTo", o.min_cans_per_month as "minCansPerMonth",
           o.agreed_list_id as "agreedListId", (select coalesce(l.book_id, l.id) from price_lists l where l.id = o.agreed_list_id) as "agreedBookId"
      from price_overrides o
      join customers c on c.id = o.customer_id
      join products p on p.id = o.product_id
     where o.cancelled_at is null and o.valid_from <= ${day}::date and (o.valid_to is null or o.valid_to >= ${day}::date)
     order by c.name asc, p.name asc
  `);
  const list = [...rows];
  if (!list.length) return [];

  const monthStart = `${day.slice(0, 7)}-01`;
  const lastStart = `${addDays(monthStart, -1).slice(0, 7)}-01`;
  const shopIds = [...new Set(list.map((r) => r.customerId))];
  const idsSql = sql.join(shopIds.map((id) => sql`${id}`), sql`, `);
  const cans = new Map<string, number>();
  const vol = await db.execute<{ customerId: string; productId: string; cans: string | number }>(sql`
    select x."customerId", x."productId", sum(x.cans) as cans from (
      select o.matched_customer_id as "customerId", o.matched_product_id as "productId", coalesce(o.cans, 0) as cans
        from sheet_order_rows o
       where o.status = 'present' and o.order_date >= ${lastStart}::date and o.order_date < ${monthStart}::date
         and o.matched_customer_id in (${idsSql})
      union all
      select e.billing_customer_id, e.sku_id, coalesce(e.qty_cans, 0)
        from erp_orders e
       where e.source = 'erp' and e.status <> 'Cancel'
         and e.order_date >= ${lastStart}::date and e.order_date < ${monthStart}::date
         and e.billing_customer_id in (${idsSql})
    ) x group by x."customerId", x."productId"
  `);
  for (const v of vol) cans.set(`${v.customerId}|${v.productId}`, Number(v.cans));

  // What each shop's book charges without its agreed list.
  const config = await getConfig();
  const opts = resolveOptionsFrom(config);
  const [{ scopes, lists }, geo, agreed] = await Promise.all([
    activeScopesAndLists(),
    geographyOf(shopIds),
    db.execute<{ id: string }>(sql`select id from price_lists where kind = 'agreed'`),
  ]);
  const agreedIds = new Set([...agreed].map((r) => r.id));
  const resolutions = new Map(
    shopIds.map((id) => {
      const g = geo.get(id);
      return [id, g ? resolvePriceList(g, scopes, lists, day, opts) : null] as const;
    }),
  );
  const need = new Set<string>();
  for (const r of resolutions.values()) for (const c of r?.candidates ?? []) if (!agreedIds.has(c.listId)) need.add(c.listId);
  const rates = await rowsForLists([...need], [...new Set(list.map((r) => r.productId))]);

  return list.map((r) => {
    let bookEx: number | null = null;
    for (const c of resolutions.get(r.customerId)?.candidates ?? []) {
      if (agreedIds.has(c.listId)) continue;
      const row = (rates.get(c.listId)?.get(r.productId) ?? []).find((x) => (x.minCans ?? 0) === 0 && x.offered);
      if (row) {
        bookEx = row.rateExGstPaise;
        break;
      }
    }
    return {
      id: r.id,
      customerId: r.customerId,
      customerName: r.customerName,
      productId: r.productId,
      productName: r.productName,
      rateExGstPaise: Number(r.rateExGstPaise),
      validTo: r.validTo,
      minCansPerMonth: r.minCansPerMonth == null ? null : Number(r.minCansPerMonth),
      lastMonthCans: cans.get(`${r.customerId}|${r.productId}`) ?? 0,
      bookExGstPaise: bookEx,
      listId: r.agreedListId,
      bookId: r.agreedBookId,
    };
  });
}

/** A finding's id is its day and key, so a re-run keeps every link to it working. */
function findingId(day: string, key: string): string {
  return `pbf_${createHash("sha1").update(`${day}|${key}`).digest("hex").slice(0, 20)}`;
}

/**
 * Write `day`'s findings. Idempotent: the day's undismissed rows of these
 * kinds are replaced, and a finding dismissed for the day is not raised again.
 */
export async function runMorningCheck(day: string): Promise<{ written: number; dismissedKept: number; detail: string }> {
  const config = await getConfig();
  const [lists, overrides] = await Promise.all([liveLists(day), liveOverrides(day)]);
  const findings = morningCheck({
    today: day,
    lists,
    overrides,
    settings: {
      typoFactor: config["pricing.changes.typoFactor"],
      expiringDays: config["pricing.today.expiringDays"],
      reminderDays: config["pricing.overrides.reminderDays"],
    },
  });
  const kinds = sql.join(MORNING_KINDS.map((k) => sql`${k}`), sql`, `);
  return db.transaction(async (tx) => {
    const dismissed = await tx.execute<{ key: string | null }>(sql`
      select detail->>'key' as key from price_book_findings
       where run_day = ${day}::date and dismissed_at is not null and kind in (${kinds})
    `);
    const keys = new Set([...dismissed].map((r) => r.key).filter((k): k is string => !!k));
    const keep = withoutDismissed(findings, keys);
    await tx.execute(sql`
      delete from price_book_findings where run_day = ${day}::date and dismissed_at is null and kind in (${kinds})
    `);
    for (const f of keep) {
      await tx.execute(sql`
        insert into price_book_findings (id, run_day, book_id, list_id, product_id, kind, severity, message, money_paise, detail)
        values (${findingId(day, f.key)}, ${day}::date, ${f.bookId}, ${f.listId}, ${f.productId}, ${f.kind}, ${f.severity},
                ${f.message}, ${f.moneyPaise}, ${JSON.stringify({ ...f.detail, key: f.key })}::jsonb)
      `);
    }
    const byKind = new Map<string, number>();
    for (const f of keep) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    const parts = [...byKind].map(([k, n]) => `${n} ${MORNING_KIND_LABEL[k as MorningKind].toLowerCase()}`);
    return {
      written: keep.length,
      dismissedKept: keys.size,
      detail: `${lists.length} live book${lists.length === 1 ? "" : "s"} checked · ${keep.length ? parts.join(", ") : "nothing found"}${keys.size ? ` · ${keys.size} dismissed kept` : ""}`,
    };
  });
}

/* ------------------------------------------------------------ the screen */

const OVERRIDE_KINDS = new Set(["override_ending", "override_condition_unmet"]);

function findingHref(kind: string, bookId: string | null): string {
  if (OVERRIDE_KINDS.has(kind)) return "/overrides";
  return bookId ? `/books/${bookId}` : "/books";
}

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

/** Last three whole months' billing per shop, divided by three. */
async function monthlyBilling(customerIds: readonly string[], day: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!customerIds.length) return out;
  const to = `${day.slice(0, 7)}-01`;
  let from = to;
  for (let i = 0; i < 3; i++) from = `${addDays(from, -1).slice(0, 7)}-01`;
  const ids = sql.join(customerIds.map((id) => sql`${id}`), sql`, `);
  const rows = await db.execute<{ customerId: string; amount: string | number }>(sql`
    select b.customer_id as "customerId", sum(b.amount) as amount
      from bills b
     where b.customer_id in (${ids}) and b.bill_date >= ${from}::date and b.bill_date < ${to}::date
     group by b.customer_id
  `);
  for (const r of rows) out.set(r.customerId, Math.round(Number(r.amount) / 3));
  return out;
}

/** Everything the Today screen draws, as of `day`, for this viewer. */
export async function priceDeskToday(day: string, userId: string): Promise<PriceDeskToday> {
  const weekEnd = addDays(day, 6);
  const { user } = await resolveScope();
  const desk = await canFor(user, "pricelist.manage");

  const [books, submitted, scheduledLists, pendingRequests, documents, findingsRows, lastRun, variance, coverage] = await Promise.all([
    listBooks(),
    db.execute<{ id: string; bookId: string; title: string | null; makerId: string; makerName: string | null; goLive: string | null; summary: unknown; bookName: string | null }>(sql`
      select pc.id, pc.book_id as "bookId", pc.title, pc.maker_id as "makerId", u.name as "makerName",
             pc.go_live::text as "goLive", pc.summary,
             (select l.name from price_lists l where l.id = pc.draft_list_id) as "bookName"
        from price_changes pc left join users u on u.id = pc.maker_id
       where pc.status = 'submitted'
       order by pc.submitted_at asc nulls last, pc.id asc
    `),
    db.execute<{ id: string; bookId: string; name: string; effectiveFrom: string; changeId: string | null }>(sql`
      select l.id, coalesce(l.book_id, l.id) as "bookId", l.name, l.effective_from::text as "effectiveFrom",
             (select pc.id from price_changes pc where pc.draft_list_id = l.id limit 1) as "changeId"
        from price_lists l
       where l.status = 'published' and l.effective_from > ${day}::date and l.effective_from <= ${weekEnd}::date
      union
      select l.id, pc.book_id, l.name, pc.go_live::text, pc.id
        from price_changes pc join price_lists l on l.id = pc.draft_list_id
       where pc.status = 'approved' and pc.go_live >= ${day}::date and pc.go_live <= ${weekEnd}::date
    `),
    db.execute<{ id: string; customerId: string; customerName: string; productId: string; productName: string; requested: string | number; current: string | number | null; requestedById: string }>(sql`
      select r.id, r.customer_id as "customerId", c.name as "customerName", r.product_id as "productId", p.name as "productName",
             r.requested_rate_ex_gst_paise as requested, r.current_rate_ex_gst_paise as current, r.requested_by_id as "requestedById"
        from price_requests r join customers c on c.id = r.customer_id join products p on p.id = r.product_id
       where r.status = 'pending'
       order by r.created_at asc
    `),
    db.execute<{ id: string; filename: string; parseStatus: string }>(sql`
      select d.id, d.filename, d.parse_status as "parseStatus" from price_list_documents d
       where d.parse_status in ('parsed', 'needs_review') order by d.created_at asc
    `),
    db.execute<{ id: string; kind: string; severity: string; bookId: string | null; listId: string | null; productId: string | null; message: string; moneyPaise: string | number | null; dismissed: boolean }>(sql`
      select f.id, f.kind, f.severity, f.book_id as "bookId", f.list_id as "listId", f.product_id as "productId",
             f.message, f.money_paise as "moneyPaise", (f.dismissed_at is not null) as dismissed
        from price_book_findings f where f.run_day = ${day}::date
    `),
    db.execute<{ at: string | null }>(sql`
      select ${ISO_TS("max(finished_at)")} as at from job_runs
       where job = 'price-books-morning' and ok and (started_at at time zone ${APP_TIMEZONE})::date = ${day}::date
    `),
    varianceForRange(addDays(day, -6), addDays(day, 1)),
    coverageReport(day),
  ]);

  /* ---- counts */
  const requests = desk ? [...pendingRequests] : [...pendingRequests].filter((r) => r.requestedById === userId);
  const below = variance.rows.filter((r) => r.listExPaise != null && (r.deltaPaise ?? 0) < 0);
  const billedBelowPaise = below.reduce((s, r) => s + Math.abs(r.deltaPaise ?? 0) * (r.cans ?? 1), 0);
  const goingLive = new Set([...scheduledLists].map((r) => r.id));

  const needs: NeedRow[] = [];

  /* ---- billed below price, by shop × product, a week scaled to a month */
  const groups = new Map<string, { customerName: string; productName: string; listName: string | null; lines: number; give: number }>();
  for (const r of below) {
    const key = `${r.customerId ?? r.customerName}|${r.productId ?? r.productName}`;
    const g = groups.get(key) ?? { customerName: r.customerName, productName: r.productName, listName: r.listName, lines: 0, give: 0 };
    g.lines++;
    g.give += Math.abs(r.deltaPaise ?? 0) * (r.cans ?? 1);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    needs.push({
      key: `below|${key}`,
      kind: "billed_below",
      findingKind: null,
      severity: null,
      title: `${g.customerName} · ${g.productName}`,
      detail: `${g.lines} line${g.lines === 1 ? "" : "s"} in the last 7 days billed ${rupees(g.give)} under ${g.listName ?? "its book"}.`,
      moneyPaise: Math.round((g.give * 30) / 7),
      href: "/watch",
      raisedByYou: false,
    });
  }

  /* ---- changes waiting approval */
  for (const c of submitted) {
    const s = (c.summary ?? {}) as { effectPerMonthPaise?: number; counts?: { changed?: number } };
    const changed = s.counts?.changed ?? null;
    needs.push({
      key: `change|${c.id}`,
      kind: "change_to_approve",
      findingKind: null,
      severity: null,
      title: `${c.bookName ?? "A book"}: ${c.title ?? "change"} waiting approval`,
      detail: `${changed != null ? `${changed} price${changed === 1 ? "" : "s"} changed` : "Prices changed"} by ${c.makerName ?? "somebody"}${c.goLive ? `, to go live ${c.goLive}` : ""}.`,
      moneyPaise: typeof s.effectPerMonthPaise === "number" ? s.effectPerMonthPaise : null,
      href: `/books/${c.bookId}/changes/${c.id}`,
      raisedByYou: c.makerId === userId,
    });
  }

  /* ---- special prices waiting */
  for (const r of requests) {
    const current = r.current == null ? null : Number(r.current);
    const cans = current != null ? ((await volumeFor([r.customerId], 6, day)).get(r.productId) ?? 0) : 0;
    const money = current != null ? Math.round((current - Number(r.requested)) * cans) : null;
    needs.push({
      key: `request|${r.id}`,
      kind: "special_price",
      findingKind: null,
      severity: null,
      title: `${r.customerName} asks ${rupees(Number(r.requested))} for ${r.productName}`,
      detail:
        current != null
          ? `Now ${rupees(current)}; about ${Math.round(cans)} can${Math.round(cans) === 1 ? "" : "s"} a month over the last 6 months.`
          : "Their current price is not known.",
      moneyPaise: money,
      href: "/requests",
      raisedByYou: false,
    });
  }

  /* ---- shops on no book */
  const noBook = coverage.unresolvedCustomers;
  const billing = await monthlyBilling(noBook.map((c) => c.id), day);
  const shops = noBook
    .map((c) => ({ c, money: billing.get(c.id) ?? 0 }))
    .sort((a, b) => b.money - a.money || a.c.name.localeCompare(b.c.name));
  for (const { c, money } of shops.slice(0, 10)) {
    needs.push({
      key: `nobook|${c.id}`,
      kind: "no_book",
      findingKind: null,
      severity: null,
      title: `${c.name} is on no price book`,
      detail: `${c.city ? `${c.city}. ` : ""}No book names this shop, so nothing prices its orders.`,
      moneyPaise: money,
      href: "/coverage",
      raisedByYou: false,
    });
  }
  const rest = coverage.unresolved - Math.min(10, shops.length);
  if (rest > 0) {
    needs.push({
      key: "nobook|rest",
      kind: "no_book",
      findingKind: null,
      severity: null,
      title: `${rest} more shop${rest === 1 ? "" : "s"} on no price book`,
      detail: "See coverage for the whole list.",
      moneyPaise: shops.slice(10).reduce((s, x) => s + x.money, 0) || null,
      href: "/coverage",
      raisedByYou: false,
    });
  }

  /* ---- books expiring with nothing scheduled */
  for (const b of books) {
    if (b.state !== "expiring" || !b.live?.expiresOn) continue;
    needs.push({
      key: `expiring|${b.id}`,
      kind: "book_expiring",
      findingKind: null,
      severity: null,
      title: `${b.name} expires ${b.live.expiresOn}`,
      detail: `Nothing is scheduled to follow it.${b.shops ? ` ${b.shops} shop${b.shops === 1 ? " is" : "s are"} priced from it.` : ""}`,
      moneyPaise: null,
      href: `/books/${b.id}`,
      raisedByYou: false,
    });
  }

  /* ---- imported PDFs waiting review */
  for (const d of documents) {
    needs.push({
      key: `doc|${d.id}`,
      kind: "document_review",
      findingKind: null,
      severity: null,
      title: `${d.filename} is waiting review`,
      detail: d.parseStatus === "needs_review" ? "It was read and some rows need a person." : "It was read and is ready to check.",
      moneyPaise: null,
      href: `/documents/${d.id}`,
      raisedByYou: false,
    });
  }

  /* ---- today's morning check */
  const findings: TodayFinding[] = [...findingsRows]
    .filter((f) => !f.dismissed)
    .map((f) => ({
      id: f.id,
      kind: f.kind,
      severity: (f.severity === "high" || f.severity === "low" ? f.severity : "medium") as TodayFinding["severity"],
      bookId: f.bookId,
      listId: f.listId,
      productId: f.productId,
      message: f.message,
      moneyPaise: f.moneyPaise == null ? null : Number(f.moneyPaise),
      href: findingHref(f.kind, f.bookId),
    }));
  const sev = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => sev[a.severity] - sev[b.severity] || (b.moneyPaise ?? 0) - (a.moneyPaise ?? 0) || a.message.localeCompare(b.message));
  for (const f of findings) {
    // An expiring book is already a row of its own above.
    if (f.kind === "expiring_unscheduled") continue;
    needs.push({
      key: `finding|${f.id}`,
      kind: "finding",
      findingKind: f.kind,
      severity: f.severity,
      title: MORNING_KIND_LABEL[f.kind as MorningKind] ?? f.kind,
      detail: f.message,
      moneyPaise: f.moneyPaise,
      href: f.href,
      raisedByYou: false,
    });
  }

  /* ---- this week */
  const events: WeekEvent[] = [];
  for (const s of scheduledLists) {
    events.push({
      key: `live|${s.id}`,
      day: s.effectiveFrom < day ? day : s.effectiveFrom,
      kind: "go_live",
      title: `${s.name} goes live`,
      href: s.changeId ? `/books/${s.bookId}/changes/${s.changeId}` : `/books/${s.bookId}`,
    });
  }
  for (const c of submitted) {
    events.push({
      key: `wait|${c.id}`,
      day: c.goLive && c.goLive >= day && c.goLive <= weekEnd ? c.goLive : day,
      kind: "waiting_approval",
      title: `${c.bookName ?? "A book"}: ${c.title ?? "change"} waits approval${c.goLive ? ` (go live ${c.goLive})` : ""}`,
      href: `/books/${c.bookId}/changes/${c.id}`,
    });
  }
  for (const b of books) {
    const e = b.live?.expiresOn;
    if (!e || e < day || e > weekEnd || b.kind !== "standard") continue;
    events.push({ key: `exp|${b.id}`, day: e, kind: "expiring", title: `${b.name} expires`, href: `/books/${b.id}` });
  }
  const week: PriceDeskToday["week"] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(day, i);
    week.push({ day: d, events: events.filter((e) => e.day === d) });
  }

  return {
    day,
    counts: {
      booksInForce: books.filter((b) => b.kind === "standard" && b.live).length,
      changesWaiting: submitted.length,
      goingLiveThisWeek: goingLive.size,
      specialPricesWaiting: requests.length,
      billedBelowPaise,
    },
    needs: byMoneyAtStake(needs),
    week,
    findings,
    checkedAt: lastRun[0]?.at ?? null,
    dismissedToday: [...findingsRows].filter((f) => f.dismissed).length,
  };
}
