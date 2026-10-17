import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "../auth";
import { levelInApp, isPlatformAdmin } from "../access-control";
import { managerScope, onlyMine } from "./sales-service";

/* ---------------------------------------------------------------------------
 * FIELD REPORTS — what a salesman files about a shop that is not a visit, an
 * order or a payment.
 *
 * Five things the handset has always been able to send and no Sales Dashboard
 * screen ever read: complaints (which reached only the CRM), competitor
 * intelligence (which reached nothing at all), internal notes (likewise), tours
 * (whose approval row said only "tour") and order change requests (which
 * reached only Accounts). They are one screen because they are one question —
 * "what has the field told us" — and five near-empty sidebar entries would be
 * five places to forget to look.
 *
 * Every read narrows through `managerScope` on the person who FILED it, the
 * same way every other list in this app does, and every read is a window with
 * its count beside it rather than a silent cap.
 * ------------------------------------------------------------------------- */

export const FIELD_REPORT_DAYS = 90;
const LIMIT = 300;

export type FieldComplaint = {
  id: string;
  createdAt: string;
  salesmanId: string;
  salesmanName: string;
  customerId: string;
  customerName: string;
  category: string;
  description: string;
  severity: string;
  status: string;
  requestCn: boolean;
  slaDueAt: string;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  photoIds: string[];
};

export type FieldCompetitor = {
  id: string;
  recordedOn: string | null;
  createdAt: string;
  salesmanId: string | null;
  salesmanName: string | null;
  customerId: string;
  customerName: string;
  competitorName: string;
  productName: string | null;
  pricePaise: number | null;
  rateNote: string | null;
  creditTerms: string | null;
  creditDays: number | null;
  deliveryNote: string | null;
  strengths: string | null;
  weaknesses: string | null;
};

export type FieldNote = {
  id: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  customerId: string;
  customerName: string;
  /** Null where the note names roles this reader does not hold. */
  body: string | null;
  restrictedTo: string[];
};

export type FieldTour = {
  id: string;
  createdAt: string;
  salesmanId: string;
  salesmanName: string;
  startDate: string;
  endDate: string;
  cities: string[];
  purpose: string | null;
  estimatedCostPaise: number | null;
  notes: string | null;
  approvalState: string | null;
  decisionNote: string | null;
};

export type FieldOrderChange = {
  id: string;
  createdAt: string;
  salesmanId: string;
  salesmanName: string;
  customerId: string;
  customerName: string;
  orderId: string;
  orderNo: string | null;
  lineItems: { product: string; quantity: number; amount: number }[];
  previousLineItems: { product: string; quantity: number; amount: number }[] | null;
  totalAmountPaise: number;
  previousTotalPaise: number | null;
  note: string;
  status: string;
  decidedByName: string | null;
  decisionNote: string | null;
};

const SINCE = sql`now() - make_interval(days => ${FIELD_REPORT_DAYS}::int)`;

/*
 * EACH TAB IS A FROM-CLAUSE, written once and read twice: by its own list and
 * by the one query that counts all five for the chips. A count derived from a
 * second spelling of the filter is a chip that disagrees with the table under
 * it the first time either changes.
 */
type Scope = Awaited<ReturnType<typeof managerScope>>;

const complaintsFrom = (scope: Scope) => sql`
      from complaints k
      join users u on u.id = k.logged_by_user_id
      join app_access a on a.user_id = u.id and a.app = 'field'
      join customers c on c.id = k.customer_id
     where k.created_at >= ${SINCE}
       ${onlyMine(scope, "u.id")}`;

const competitorsFrom = (scope: Scope) => sql`
      from mbos_competitor_records r
      join customers c on c.id = r.customer_id
      left join users u on u.id = r.created_by_id
     where r.server_created_at >= ${SINCE}
       ${onlyMine(scope, "r.created_by_id")}`;

const notesFrom = (scope: Scope) => sql`
      from mbos_internal_notes n
      join users u on u.id = n.author_id
      join customers c on c.id = n.customer_id
     where n.removed_at is null
       and n.server_created_at >= ${SINCE}
       ${onlyMine(scope, "n.author_id")}`;

/* A tour still ahead is shown however long ago it was asked for. */
const toursFrom = (scope: Scope) => sql`
      from mbos_tours t
      join users u on u.id = t.user_id
      left join lateral (
        select ap.state, ap.decision_note
          from mbos_approvals ap
         where ap.type = 'tour' and ap.subject_id = t.id
         order by ap.step_index desc, ap.requested_at desc
         limit 1
      ) top on true
     where (t.server_created_at >= ${SINCE} or t.end_date >= current_date)
       ${onlyMine(scope, "t.user_id")}`;

const changesFrom = (scope: Scope) => sql`
      from order_change_requests r
      join users u on u.id = r.requested_by_id
      join customers c on c.id = r.customer_id
      join orders o on o.id = r.order_id
      left join users d on d.id = r.decided_by_id
     where r.created_at >= ${SINCE}
       ${onlyMine(scope, "r.requested_by_id")}`;

async function list<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/** Complaints a salesman raised on the handset. The CRM's complaint desk is
 * where they are worked; this is where his manager sees that he raised them. */
export async function fieldComplaints(): Promise<FieldComplaint[]> {
  const scope = await managerScope();
  return list<FieldComplaint>(sql`
    select k.id, k.created_at as "createdAt",
           u.id as "salesmanId", u.name as "salesmanName",
           c.id as "customerId", c.name as "customerName",
           k.category::text as category, k.description, k.severity::text as severity,
           k.status::text as status, k.request_cn as "requestCn",
           k.sla_due_at as "slaDueAt", k.resolved_at as "resolvedAt",
           k.resolution_notes as "resolutionNotes",
           coalesce((select array_agg(f.id order by f.uploaded_at)
                       from attachments f
                      where f.parent_type = 'complaint' and f.parent_id = k.id
                        and f.status = 'available'), '{}') as "photoIds"
      ${complaintsFrom(scope)}
     order by k.created_at desc
     limit ${LIMIT}`);
}

/** What the field learned about the competition, shop by shop. */
export async function fieldCompetitors(): Promise<FieldCompetitor[]> {
  const scope = await managerScope();
  return list<FieldCompetitor>(sql`
    select r.id, r.recorded_on::text as "recordedOn", r.server_created_at as "createdAt",
           u.id as "salesmanId", u.name as "salesmanName",
           c.id as "customerId", c.name as "customerName",
           r.competitor_name as "competitorName", r.product_name as "productName",
           r.price_paise as "pricePaise", r.rate_note as "rateNote",
           r.credit_terms as "creditTerms", r.credit_days as "creditDays",
           r.delivery_note as "deliveryNote",
           r.strengths, r.weaknesses
      ${competitorsFrom(scope)}
     order by r.server_created_at desc
     limit ${LIMIT}`);
}

/**
 * Internal notes written in the field.
 *
 * `visible_to_roles` is honoured as the brief means it: empty is everybody who
 * can see the shop, and a list narrows to those levels. A note this reader may
 * not read is still LISTED — that one exists is not secret, and a gap would
 * read as nothing having been written — but its body is withheld in SQL, so the
 * words never leave the server.
 */
export async function fieldNotes(): Promise<FieldNote[]> {
  const user = await requireUser();
  const [scope, level, admin] = await Promise.all([
    managerScope(),
    levelInApp(user, "sales"),
    isPlatformAdmin(user),
  ]);
  const roles = [level ?? "associate", ...(admin ? ["admin"] : [])];
  const roleList = sql.join(
    roles.map((r) => sql`${r}`),
    sql`, `,
  );
  return list<FieldNote>(sql`
    select n.id, n.server_created_at as "createdAt",
           u.id as "authorId", u.name as "authorName",
           c.id as "customerId", c.name as "customerName",
           case when jsonb_array_length(n.visible_to_roles) = 0
                  or n.author_id = ${user.id}
                  or exists (select 1 from jsonb_array_elements_text(n.visible_to_roles) vr
                              where vr in (${roleList}))
                then n.body end as body,
           coalesce((select array_agg(vr) from jsonb_array_elements_text(n.visible_to_roles) vr),
                    '{}') as "restrictedTo"
      ${notesFrom(scope)}
     order by n.server_created_at desc
     limit ${LIMIT}`);
}

/** Tours a salesman asked to make, with where their approval stands. */
export async function fieldTours(): Promise<FieldTour[]> {
  const scope = await managerScope();
  return list<FieldTour>(sql`
    select t.id, t.server_created_at as "createdAt",
           u.id as "salesmanId", u.name as "salesmanName",
           t.start_date::text as "startDate", t.end_date::text as "endDate",
           coalesce((select array_agg(x) from jsonb_array_elements_text(t.cities) x), '{}')
             as cities,
           t.purpose, t.estimated_cost_paise as "estimatedCostPaise", t.notes,
           top.state::text as "approvalState", top.decision_note as "decisionNote"
      ${toursFrom(scope)}
     order by t.start_date desc
     limit ${LIMIT}`);
}

/** Changes a salesman asked for on an order already sent. Accounts decide
 * them; this is where his manager sees what was asked and how it went. */
export async function fieldOrderChanges(): Promise<FieldOrderChange[]> {
  const scope = await managerScope();
  return list<FieldOrderChange>(sql`
    select r.id, r.created_at as "createdAt",
           u.id as "salesmanId", u.name as "salesmanName",
           c.id as "customerId", c.name as "customerName",
           o.id as "orderId", o.order_no as "orderNo",
           r.line_items as "lineItems", r.previous_line_items as "previousLineItems",
           r.total_amount_paise as "totalAmountPaise",
           r.previous_total_paise as "previousTotalPaise",
           r.note, r.status::text as status,
           d.name as "decidedByName", r.decision_note as "decisionNote"
      ${changesFrom(scope)}
     order by r.created_at desc
     limit ${LIMIT}`);
}

export type FieldReportTab = "complaints" | "competition" | "notes" | "tours" | "changes";

/** All five counts in one round trip, over exactly the windows the tabs read. */
export async function fieldReportCounts(): Promise<Record<FieldReportTab, number>> {
  const scope = await managerScope();
  const [row] = (await db.execute(sql`
    select (select count(*)::int ${complaintsFrom(scope)}) as complaints,
           (select count(*)::int ${competitorsFrom(scope)}) as competition,
           (select count(*)::int ${notesFrom(scope)}) as notes,
           (select count(*)::int ${toursFrom(scope)}) as tours,
           (select count(*)::int ${changesFrom(scope)}) as changes
  `)) as unknown as Record<FieldReportTab, number>[];
  return {
    complaints: Number(row?.complaints ?? 0),
    competition: Number(row?.competition ?? 0),
    notes: Number(row?.notes ?? 0),
    tours: Number(row?.tours ?? 0),
    changes: Number(row?.changes ?? 0),
  };
}

/** The most any one tab shows; the chip count says when there are more. */
export const FIELD_REPORT_LIMIT = LIMIT;
