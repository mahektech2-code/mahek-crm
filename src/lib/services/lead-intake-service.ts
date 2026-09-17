import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "../business-date";
import { leadsVisible, managerScope } from "./sales-service";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import { getConfig } from "@/lib/config/store";

/* ---------------------------------------------------------------------------
 * Every read the INTAKE end of the funnel makes — screens 5, 34 and 7.
 *
 * Intake is the one part of Lead Management that is not a worklist. The rest of
 * the workspace asks "what is waiting on me"; this asks "is this shop already
 * on the book, and who is there to owe the first action on it" — two questions
 * with almost no SQL in common with the queues, which is why they are here
 * rather than in `lead-console-service.ts`.
 *
 * The three rules the rest of the Sales Dashboard's services run on are kept
 * exactly, because a screen that skips one of them is a way round it rather
 * than a screen:
 *
 * **Scope is resolved here and never passed in.** `managerScope()` reads the
 * session inside the service, so no page can forget the narrowing — and a
 * forgotten narrowing is silent, looks like working software, and shows a
 * regional manager the whole country's book. The duplicates screen is the one
 * that would hurt most: a pair is two customer records with their phone
 * numbers and towns on the screen, so BOTH sides are narrowed rather than the
 * left one alone.
 *
 * **Raw SQL, every column of the outer table qualified.** Drizzle renders
 * `${customers.id}` as a bare `"id"`, which inside a correlated subquery binds
 * to the INNER table and silently makes the condition false.
 *
 * **No bare cast of a timestamp to a date.** `created_at` is rendered with
 * `at time zone ${APP_TIMEZONE}` before it is truncated, so a lead raised at
 * 1am in Mumbai is not reported as yesterday's on a database running in GMT.
 *
 * Reads only. Every write is in `lib/actions/lead-intake.ts`.
 * ------------------------------------------------------------------------- */

/* ═══════════════════════════════════════════════ screen 5 — what to offer */

export type LeadSourceOption = {
  /** Exactly as it is stored. This is a join key for screen 6, not a label. */
  source: string;
  count: number;
};

/**
 * Every `lead_source` already on the book, commonest first.
 *
 * It is a READ of the column rather than a list typed into the form, and the
 * difference is the whole reason screen 6 exists: `lead_source` is free text,
 * so "Website", "website" and "Web site" are three sources for ever unless the
 * next person to raise a lead is shown what is already being used. Offering
 * the stored spellings is the cheapest thing that stops the list growing, and
 * it costs one grouped read.
 *
 * It does NOT restrict what may be typed. A source nobody has used before is a
 * real answer — a trade fair happens once — and a form that refused one would
 * teach people to pick the nearest wrong option, which is worse for screen 6
 * than a new spelling is.
 *
 * Deliberately NOT scoped: a source is a fact about where business comes from
 * and not about whose book a shop is in, and narrowing this to one manager's
 * team would offer a regional manager a shorter list of spellings and so
 * produce MORE of them.
 */
export async function leadSourceOptions(): Promise<LeadSourceOption[]> {
  const rows = await db.execute<LeadSourceOption>(sql`
    select c.lead_source as source, count(*)::int as count
      from customers c
     where c.lead_source is not null
       and length(btrim(c.lead_source)) > 0
     group by c.lead_source
     order by count(*) desc, c.lead_source asc
     limit 200
  `);
  return rows as unknown as LeadSourceOption[];
}

export type NextActionOwner = {
  id: string;
  name: string;
  email: string | null;
  /** How many leads already owe this person an action. Shown beside the name. */
  owed: number;
};

/**
 * Who a next action may be owed BY.
 *
 * §24's rule is that an active lead never sits with nothing owed by anybody,
 * and "anybody" has to mean a person who can sign in and see it — a next
 * action against somebody who cannot open MahekOne is the same as no next
 * action, with the added harm that a screen says one exists. So this is
 * `users` with an active account, and the action checks the same thing rather
 * than trusting the picker: a picker is not a permission.
 *
 * The count beside each name is not decoration. The whole cost of raising a
 * lead at a desk is that it lands on somebody else's list, and a form that
 * showed nine names and nothing else makes it accidental which of them gets
 * the twentieth lead this week.
 */
export async function nextActionOwners(): Promise<NextActionOwner[]> {
  const rows = await db.execute<NextActionOwner>(sql`
    select u.id, u.name, u.email,
           (select count(*)::int from customers c
             where c.lead_next_action_owner_id = u.id
               and c.kind = 'lead'
               and c.lead_archived = false) as owed
      from users u
     where u.active
     order by u.name asc
  `);
  return rows as unknown as NextActionOwner[];
}

/* ════════════════════════════════════ the guard in front of a fresh capture */

export type ExistingAccount = {
  id: string;
  name: string;
  companyName: string | null;
  city: string | null;
  kind: "lead" | "customer";
  stage: LeadStage | null;
  ownerName: string | null;
};

/**
 * Is this telephone number already on the book?
 *
 * Asked BEFORE a capture is written, because the cheapest duplicate to deal
 * with is the one that is never created: screen 7 exists precisely because
 * MahekOne cannot merge two `customers` rows, so a second row for one shop is
 * damage nobody can undo from a screen.
 *
 * Matched on the LAST TEN DIGITS of whatever is stored, because the same
 * mobile reaches this book as `9820011001`, `+91 98200 11001` and
 * `098200-11001` depending on which door it came through. A match on the raw
 * string would miss every one of those and the guard would read as working.
 *
 * NOT scoped, and that is deliberate. This answers "does this record exist",
 * not "may you read it" — narrowing it would let a telecaller create a second
 * row for a shop that is sitting in another manager's book, which is exactly
 * the duplicate this exists to stop. What the caller may SHOW of the answer is
 * a separate question, and the action keeps it to the name and the town.
 */
export async function phoneAlreadyOnTheBook(
  phone: string,
): Promise<ExistingAccount | null> {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);

  const rows = (await db.execute<ExistingAccount>(sql`
    select c.id, c.name, c.company_name as "companyName", c.city,
           c.kind::text as kind, c.lead_stage::text as stage,
           u.name as "ownerName"
      from customers c
      left join users u on u.id = c.owner_id
     where right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
     order by c.created_at asc
     limit 1
  `)) as unknown as ExistingAccount[];

  return rows[0] ?? null;
}

/**
 * The same question asked of a whole file, in one statement.
 *
 * A bulk preview has to answer it for every row, and a thousand rows is a
 * thousand round trips through `phoneAlreadyOnTheBook` — which is the sort of
 * preview people stop waiting for and then commit blind. Keyed by the last ten
 * digits rather than by the spelling the file used, so the caller looks the
 * answer up the same way the match was made.
 */
export async function phonesOnTheBook(
  phones: string[],
): Promise<Map<string, ExistingAccount>> {
  const last10 = Array.from(
    new Set(
      phones
        .map((p) => p.replace(/[^0-9]/g, ""))
        .filter((d) => d.length >= 10)
        .map((d) => d.slice(-10)),
    ),
  );
  if (!last10.length) return new Map();

  const rows = (await db.execute<ExistingAccount & { key: string }>(sql`
    select right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) as key,
           c.id, c.name, c.company_name as "companyName", c.city,
           c.kind::text as kind, c.lead_stage::text as stage,
           u.name as "ownerName"
      from customers c
      left join users u on u.id = c.owner_id
     where right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)
           in (${sql.join(
             last10.map((d) => sql`${d}`),
             sql`, `,
           )})
  `)) as unknown as Array<ExistingAccount & { key: string }>;

  const found = new Map<string, ExistingAccount>();
  for (const r of rows) if (!found.has(r.key)) found.set(r.key, r);
  return found;
}

/* ═══════════════════════════════════════════ screen 7 — duplicate detection */

/**
 * How alike two names have to be, in the same town, to be worth a person's eye.
 *
 * A CONSTANT, and it should not be one. AGENTS.md's rule is that nothing
 * business-critical is typed into code — this decides how much work lands on
 * somebody's screen and is exactly the number a manager would want to turn
 * down after a week of false pairs. It belongs in `lib/config/registry.ts` as
 * `leads.duplicateNameSimilarity`, and the reason it is not there yet is that
 * It IS configuration now — `leads.duplicateNameSimilarity` — because it
 * decides how much work lands on somebody's screen, which is exactly the kind
 * of number a manager wants to turn down after a week of using the screen.
 *
 * 0.55 is deliberately above pg_trgm's own default of 0.3: at 0.3 every second
 * paint shop in a town matches every other on the word "paints", and a list
 * nobody believes is a list nobody opens.
 */
async function nameSimilarityThreshold(): Promise<number> {
  const config = await getConfig();
  return config["leads.duplicateNameSimilarity"];
}

export type DuplicateReason = "phone" | "gstin" | "name";

export type DuplicateSide = {
  id: string;
  name: string;
  companyName: string | null;
  city: string | null;
  phone: string | null;
  gstin: string | null;
  kind: "lead" | "customer";
  stage: LeadStage | null;
  salesType: LeadSalesType | null;
  source: string | null;
  ownerName: string | null;
  /** In Asia/Kolkata, resolved in SQL — never a bare cast of the timestamp. */
  createdOn: string | null;
  orders: number;
};

export type DuplicatePair = {
  /** `<left id>:<right id>`, ids in ascending order. The dismissal's key. */
  key: string;
  /** Every rule that fired, so the evidence can be shown rather than summarised. */
  reasons: DuplicateReason[];
  /** Trigram similarity where the names matched; null where they did not. */
  nameScore: number | null;
  left: DuplicateSide;
  right: DuplicateSide;
};

export type DuplicateReport = {
  pairs: DuplicatePair[];
  /** Before the cap. A capped list has to say what it is a slice of. */
  total: number;
  /** Pairs somebody has already answered "not a duplicate" about. */
  dismissed: number;
};

/**
 * The name under which a dismissal is recorded, read here and written by
 * `dismissDuplicatePair`. One constant, because it is a join key: a spelling
 * that drifts by one character makes every previous dismissal invisible and
 * the pairs all come back.
 */
export const DUPLICATE_DISMISSED_ACTION = "lead.duplicate.dismissed";

/**
 * Candidate pairs, with the evidence for each.
 *
 * THREE RULES, and they are unioned rather than OR-ed into one join so that
 * each pair can say which of them fired. "Same phone AND a close name" and
 * "only a close name" are very different amounts of evidence, and a screen
 * that reported both as "possible duplicate" would be asking somebody to open
 * two records to find out which they are looking at.
 *
 *   phone — the last ten digits agree. Near-certain, and the commonest real
 *           duplicate: a website form and a salesman's handset both reaching
 *           one shop.
 *   gstin — the same registration. Certain, and rare on this book: 5,292 shops
 *           came out of the EMP 2.0 master with no GSTIN between them.
 *   name  — trigram similarity inside the SAME town. The extension and the
 *           `customers_name_trgm_idx` GIN index already exist (migrations 0008
 *           and 0072). The `%` operator is what uses that index; the explicit
 *           `similarity(...) >=` beside it is what applies OUR threshold rather
 *           than pg_trgm's session default, and both are needed.
 *
 * AT LEAST ONE SIDE IS A LEAD. This is the Lead Management workspace and the
 * question it answers is "did we raise this shop twice". Two long-standing
 * customer records that look alike is a real problem and a different one — it
 * is the accounts book, with orders, bills and receipts on both sides, and
 * surfacing it here would bury the pairs somebody can actually do something
 * about under a list nobody on this screen owns.
 *
 * ARCHIVED LEADS ARE OUT. A lead filed away by the staleness sweep is not a
 * shop somebody is about to raise a second row for, and including them would
 * put years of cold leads in front of the handful that matter.
 *
 * Both sides are narrowed by `managerScope`, not just the left one — see the
 * file header.
 */
export async function duplicateCandidates({
  limit = 100,
}: { limit?: number } = {}): Promise<DuplicateReport> {
  const scope = await managerScope();
  const nameSimilarity = await nameSimilarityThreshold();

  /*
   * The shared half of all three rules. `a.id < b.id` is what makes a pair
   * appear once rather than twice with its sides swapped — and it is also why
   * the dismissal key can be built by concatenation without sorting again.
   */
  const both = sql`
    a.id < b.id
    and a.lead_archived = false
    and b.lead_archived = false
    and (a.kind = 'lead' or b.kind = 'lead')
    ${leadsVisible(scope, "a.owner_id")}
    ${leadsVisible(scope, "b.owner_id")}
  `;

  const phoneDigits = (alias: string) =>
    sql`right(regexp_replace(coalesce(${sql.raw(alias)}.phone, ''), '[^0-9]', '', 'g'), 10)`;

  const pairs = sql`
    with pairs as (
      select a.id as l, b.id as r, 'phone'::text as reason, null::float4 as score
        from customers a
        join customers b
          on ${phoneDigits("a")} = ${phoneDigits("b")}
         and length(${phoneDigits("a")}) = 10
       where ${both}
      union all
      select a.id as l, b.id as r, 'gstin'::text as reason, null::float4 as score
        from customers a
        join customers b
          on upper(btrim(a.gstin)) = upper(btrim(b.gstin))
         and length(btrim(coalesce(a.gstin, ''))) > 0
       where ${both}
      union all
      select a.id as l, b.id as r, 'name'::text as reason,
             similarity(a.name, b.name) as score
        from customers a
        join customers b
          on a.name % b.name
         and similarity(a.name, b.name) >= ${nameSimilarity}
         and lower(btrim(a.city)) = lower(btrim(b.city))
         and length(btrim(coalesce(a.city, ''))) > 0
       where ${both}
    ),
    grouped as (
      select p.l, p.r,
             array_agg(distinct p.reason order by p.reason) as reasons,
             max(p.score) as "nameScore"
        from pairs p
       group by p.l, p.r
    ),
    live as (
      select g.l, g.r, g.reasons, g."nameScore"
        from grouped g
       where not exists (
         select 1 from audit_log al
          where al.action = ${DUPLICATE_DISMISSED_ACTION}
            and al.entity_id = g.l || ':' || g.r
       )
    )
  `;

  /*
   * One side's columns, built as TEXT and interpolated whole.
   *
   * `alias` and `prefix` are this function's own literals and never reach it
   * from a request, so `sql.raw` is safe here — and it is what keeps the
   * backticks of a nested template out of the query template itself, where a
   * stray one terminates the literal and the failure is reported nowhere
   * useful. `created_at` is rendered through `at time zone` before it is
   * truncated, never as a bare cast.
   */
  const side = (alias: string, prefix: string) =>
    sql.raw(
      [
        `${alias}.id as "${prefix}Id"`,
        `${alias}.name as "${prefix}Name"`,
        `${alias}.company_name as "${prefix}CompanyName"`,
        `${alias}.city as "${prefix}City"`,
        `${alias}.phone as "${prefix}Phone"`,
        `${alias}.gstin as "${prefix}Gstin"`,
        `${alias}.kind::text as "${prefix}Kind"`,
        `${alias}.lead_stage::text as "${prefix}Stage"`,
        `${alias}.lead_sales_type::text as "${prefix}SalesType"`,
        `${alias}.lead_source as "${prefix}Source"`,
        `u_${prefix}.name as "${prefix}OwnerName"`,
        `to_char(${alias}.created_at at time zone '${APP_TIMEZONE}', 'YYYY-MM-DD') as "${prefix}CreatedOn"`,
        `(select count(*)::int from orders o where o.customer_id = ${alias}.id) as "${prefix}Orders"`,
      ].join(",\n             "),
    );

  type Flat = Record<string, unknown>;

  const [rows, counts] = await Promise.all([
    db.execute<Flat>(sql`
      ${pairs}
      select v.reasons, v."nameScore",
             ${side("la", "left")},
             ${side("ra", "right")}
        from live v
        join customers la on la.id = v.l
        join customers ra on ra.id = v.r
        left join users u_left on u_left.id = la.owner_id
        left join users u_right on u_right.id = ra.owner_id
       order by
         case when 'phone' = any(v.reasons) then 0
              when 'gstin' = any(v.reasons) then 1
              else 2 end asc,
         coalesce(v."nameScore", 0) desc,
         la.name asc
       limit ${limit}
    `),
    db.execute<{ total: number; dismissed: number }>(sql`
      ${pairs}
      select (select count(*)::int from live) as total,
             (select count(*)::int from grouped)
               - (select count(*)::int from live) as dismissed
    `),
  ]);

  const sideOf = (r: Flat, prefix: string): DuplicateSide => ({
    id: String(r[`${prefix}Id`]),
    name: String(r[`${prefix}Name`] ?? ""),
    companyName: (r[`${prefix}CompanyName`] as string | null) ?? null,
    city: (r[`${prefix}City`] as string | null) ?? null,
    phone: (r[`${prefix}Phone`] as string | null) ?? null,
    gstin: (r[`${prefix}Gstin`] as string | null) ?? null,
    kind: (r[`${prefix}Kind`] as "lead" | "customer") ?? "lead",
    stage: (r[`${prefix}Stage`] as LeadStage | null) ?? null,
    salesType: (r[`${prefix}SalesType`] as LeadSalesType | null) ?? null,
    source: (r[`${prefix}Source`] as string | null) ?? null,
    ownerName: (r[`${prefix}OwnerName`] as string | null) ?? null,
    createdOn: (r[`${prefix}CreatedOn`] as string | null) ?? null,
    orders: Number(r[`${prefix}Orders`] ?? 0),
  });

  const pairRows = (rows as unknown as Flat[]).map((r): DuplicatePair => {
    const left = sideOf(r, "left");
    const right = sideOf(r, "right");
    return {
      key: `${left.id}:${right.id}`,
      reasons: ((r.reasons as DuplicateReason[] | null) ?? []).slice(),
      nameScore: r.nameScore == null ? null : Number(r.nameScore),
      left,
      right,
    };
  });

  const c = (counts as unknown as Array<{ total: number; dismissed: number }>)[0];

  return {
    pairs: pairRows,
    total: Number(c?.total ?? pairRows.length),
    dismissed: Number(c?.dismissed ?? 0),
  };
}

/** The threshold the screen prints, so it says what it actually searched on. */
export async function duplicateNameThreshold(): Promise<number> {
  return nameSimilarityThreshold();
}
