import "server-only";
import { aliasedTable, and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { customers, places } from "@/db/schema";
import { scopedToUsers } from "@/lib/access-control";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
import { likePattern, searchTerms } from "@/lib/promo-feed";
import { frequentProducts } from "@/lib/services/product-service";
import type { Product } from "./domain/product";
import type { Recipient, RecipientKind } from "./domain/recipient";

/* ---------------------------------------------------------------------------
 * WHO A POSTER CAN BE MADE FOR — read straight off the book, through scope.
 *
 * The standalone Studio read these through a feed that saw the whole company
 * and decided nothing about who was asking. Inside MahekOne the answer is the
 * same one every other list gives: `scopedToUsers`, so a telecaller makes
 * posters for their own leads and customers and a manager for their team's.
 *
 * Three lists, because they are three different conversations: a NEW lead is
 * being welcomed, a CUSTOMER is being kept, and a LOST lead is being won back.
 * A lost lead is greeted with the lead designs and wording — it has never
 * bought anything — and the list is its own so nobody wishes a shop that said
 * no in the same breath as one that is still deciding.
 * ------------------------------------------------------------------------- */

export const RECIPIENT_LISTS = ["lead", "customer", "lost"] as const;
export type RecipientList = (typeof RECIPIENT_LISTS)[number];
export const LIST_LABEL: Record<RecipientList, string> = { lead: "Leads", customer: "Customers", lost: "Lost leads" };
export const isRecipientList = (v: unknown): v is RecipientList => typeof v === "string" && (RECIPIENT_LISTS as readonly string[]).includes(v);

/** The designs and wording a list is offered: a lost lead is still a lead. */
export const audienceOf = (list: RecipientList): RecipientKind => (list === "customer" ? "customer" : "lead");

const stateOf = aliasedTable(places, "studio_state");

export type RecipientRow = {
  id: string;
  list: RecipientList;
  company: string;
  contact: string | null;
  city: string;
  state: string;
  stage: string | null;
  doNotContact: boolean;
};

export type RecipientDetail = RecipientRow & {
  audience: RecipientKind;
  recipient: Recipient;
  /** The number a WhatsApp chat opens on: the WhatsApp number where one is set, else the phone. */
  whatsappPhone: string | null;
  whatsappDnd: boolean;
  /** What they buy, most often first — offered as the poster's product. */
  products: Product[];
};

function listClause(list: RecipientList): SQL | undefined {
  if (list === "customer") return eq(customers.kind, "customer");
  if (list === "lost") return and(eq(customers.kind, "lead"), eq(customers.leadArchived, false), eq(customers.leadStage, "lost"));
  return and(eq(customers.kind, "lead"), eq(customers.leadArchived, false), or(isNull(customers.leadStage), ne(customers.leadStage, "lost")));
}

function listOf(row: { kind: string; leadStage: string | null }): RecipientList {
  if (row.kind === "customer") return "customer";
  return row.leadStage === "lost" ? "lost" : "lead";
}

const COLUMNS = {
  id: customers.id,
  kind: customers.kind,
  name: customers.name,
  companyName: customers.companyName,
  contactPerson: customers.contactPerson,
  city: customers.city,
  stateName: stateOf.name,
  leadStage: customers.leadStage,
  leadArchived: customers.leadArchived,
  doNotContact: customers.doNotContact,
  whatsappDnd: customers.whatsappDnd,
  phone: customers.phone,
  whatsappPhone: customers.whatsappPhone,
};
type Raw = { [K in keyof typeof COLUMNS]: unknown };

function shape(r: Raw): RecipientRow {
  const kind = String(r.kind);
  const stage = (r.leadStage as string | null) ?? null;
  const company = String(r.companyName ?? "").trim() || String(r.name ?? "").trim();
  const contact = String(r.contactPerson ?? "").trim() || null;
  return {
    id: String(r.id),
    list: listOf({ kind, leadStage: stage }),
    company,
    contact: contact && contact.toLowerCase() !== company.toLowerCase() ? contact : null,
    city: String(r.city ?? "").trim(),
    state: String(r.stateName ?? "").trim(),
    stage: kind === "lead" && stage ? stageLabel(stage as LeadStage) : null,
    doNotContact: Boolean(r.doNotContact),
  };
}

export const RECIPIENT_PAGE = 25;

/** A SKU name without its pack: everything before " - <size>". */
export function posterProductName(sku: string): string {
  return sku.split(/\s+-\s+(?=\d|\()/)[0]!.trim();
}

/** One page of a list, in the asker's scope, newest first. `userIds` null is the whole book. */
export async function listRecipients(input: { userIds: string[] | null; list: RecipientList; q?: string | null; page?: number; pageSize?: number }): Promise<{ rows: RecipientRow[]; total: number; page: number; pageCount: number }> {
  const pageSize = input.pageSize ?? RECIPIENT_PAGE;
  const parts: (SQL | undefined)[] = [scopedToUsers(input.userIds), listClause(input.list)];
  for (const term of searchTerms(input.q ?? "")) {
    const p = likePattern(term);
    parts.push(or(ilike(customers.name, p), ilike(customers.companyName, p), ilike(customers.contactPerson, p), ilike(customers.city, p)));
  }
  const where = and(...parts);
  const [{ n }] = await db.select({ n: count() }).from(customers).where(where);
  const total = Number(n);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, input.page ?? 1), pageCount);
  const rows = await db
    .select(COLUMNS)
    .from(customers)
    .leftJoin(stateOf, eq(customers.resolvedStateId, stateOf.id))
    .where(where)
    .orderBy(desc(customers.createdAt), asc(customers.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows: rows.map(shape), total, page, pageCount };
}

/** Several recipients by id, in scope — the bulk run's list. Anything out of scope is simply absent. */
export async function recipientsByIds(userIds: string[] | null, ids: readonly string[]): Promise<RecipientRow[]> {
  if (!ids.length) return [];
  const rows = await db
    .select(COLUMNS)
    .from(customers)
    .leftJoin(stateOf, eq(customers.resolvedStateId, stateOf.id))
    .where(and(scopedToUsers(userIds), inArray(customers.id, [...ids]), or(eq(customers.kind, "customer"), eq(customers.leadArchived, false))));
  return rows.map(shape);
}

/**
 * One recipient, in scope, with what a poster needs. Null where it does not
 * exist or the asker may not see it — the two answer identically, so this
 * cannot be used to find out whether an id is somebody else's customer.
 */
export async function getRecipient(userIds: string[] | null, id: string): Promise<RecipientDetail | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(customers)
    .leftJoin(stateOf, eq(customers.resolvedStateId, stateOf.id))
    .where(and(scopedToUsers(userIds), eq(customers.id, id), or(eq(customers.kind, "customer"), eq(customers.leadArchived, false))))
    .limit(1);
  if (!row) return null;
  const base = shape(row);
  const bought = base.list === "customer" ? await frequentProducts(base.id).catch(() => []) : [];
  /* A SKU's name carries its packing — "Epoxy Thinner - 1 Liter (32 Can/Box)" —
     which is how an order is written and not how a greeting reads. The poster
     names the product; two packs of one product are one choice. */
  const seen = new Set<string>();
  const products: Product[] = [];
  for (const p of bought) {
    const name = posterProductName(p.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    products.push({ id: p.productId, code: p.productId, name });
  }
  const phone = String(row.whatsappPhone ?? "").trim() || String(row.phone ?? "").trim() || null;
  return {
    ...base,
    audience: audienceOf(base.list),
    recipient: { contact: base.contact, company: base.company, city: base.city, state: base.state, product: products[0] ?? null },
    whatsappPhone: phone,
    whatsappDnd: Boolean(row.whatsappDnd),
    products,
  };
}

/** How many of each list the asker has, for the tabs. */
export async function recipientCounts(userIds: string[] | null): Promise<Record<RecipientList, number>> {
  const scope = scopedToUsers(userIds);
  const [lead, customer, lost] = await Promise.all(
    RECIPIENT_LISTS.map((l) =>
      db
        .select({ n: count() })
        .from(customers)
        .where(and(scope, listClause(l)))
        .then((r) => Number(r[0]?.n ?? 0)),
    ),
  );
  return { lead, customer, lost };
}

/** Do-not-contact, for the sentence on the poster page. */
export const DNC_WARNING = "This contact is marked Do Not Contact. You may make and download the poster, but do not send it to them.";

