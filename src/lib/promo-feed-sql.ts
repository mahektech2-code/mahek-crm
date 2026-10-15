import { and, asc, desc, eq, ilike, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { customers, places, users, type mbosLeadStageEnum } from "@/db/schema";
import { likePattern, searchTerms, type PromoFeedQuery, type PromoFilters } from "@/lib/promo-feed";

/* ---------------------------------------------------------------------------
 * The SQL pieces of the Promotional App feed, built WITHOUT touching a
 * database connection so they can be tested by rendering them. This file only
 * builds read expressions (filters, ordering, joins' aliases): the one file
 * that runs them is `services/promo-feed-service.ts`.
 *
 * Every value a caller sends reaches the database as a bound parameter,
 * never as part of the SQL text.
 * ------------------------------------------------------------------------- */

export const promoOwner = alias(users, "promo_owner");
export const promoAccountManager = alias(users, "promo_am");
export const promoSalesManager = alias(users, "promo_sm");
export const promoState = alias(places, "promo_state");
export const promoDistrict = alias(places, "promo_district");

type LeadStage = (typeof mbosLeadStageEnum.enumValues)[number];

/** Who a record is shown as belonging to: a lead's owner; a customer's account manager, else whoever first found it. */
export const DISPLAY_OWNER_ID = sql`case when ${customers.kind} = 'lead' then ${customers.ownerId} else coalesce(${customers.salesAmId}, ${customers.ownerId}) end`;
export const COUNT = sql<number>`count(*)::int`;

/** The WHERE for a set of filters. Pure: building it touches no database, so it can be tested by rendering it. */
export function promoWhere(f: PromoFilters): SQL | undefined {
  const parts: (SQL | undefined)[] = [
    // a lead in the trash is not listed; a customer is listed with its flag
    or(eq(customers.kind, "customer"), isNull(customers.deletedAt)),
    f.kind ? eq(customers.kind, f.kind) : undefined,
    // archived and lost leads are the restricted ones; customers are never restricted by this
    f.restricted === "exclude"
      ? or(eq(customers.kind, "customer"), and(eq(customers.leadArchived, false), or(isNull(customers.leadStage), ne(customers.leadStage, "lost"))))
      : undefined,
    f.state ? eq(customers.resolvedStateId, f.state) : undefined,
    f.district ? eq(customers.resolvedDistrictId, f.district) : undefined,
    f.city ? sql`lower(${customers.city}) = lower(${f.city})` : undefined,
    f.owner ? sql`${DISPLAY_OWNER_ID} = ${f.owner}` : undefined,
    f.salesManager ? eq(customers.salesManagerId, f.salesManager) : undefined,
    f.stage ? and(eq(customers.kind, "lead"), eq(customers.leadStage, f.stage as LeadStage)) : undefined,
    f.status ? and(eq(customers.kind, "customer"), eq(customers.status, f.status)) : undefined,
  ];
  if (f.q) {
    // every word must match somewhere; the words are LIKE-escaped and bound, never part of the SQL text
    for (const term of searchTerms(f.q)) {
      const pattern = likePattern(term);
      parts.push(
        or(
          ilike(customers.name, pattern),
          ilike(customers.companyName, pattern),
          ilike(customers.contactPerson, pattern),
          ilike(customers.city, pattern),
          ilike(promoState.name, pattern),
          ilike(promoDistrict.name, pattern),
        ),
      );
    }
  }
  return and(...parts);
}

/** The ORDER BY for a sort: always ends on the id, so the order is total and a page never overlaps the next. */
export function promoOrderBy(sort: PromoFeedQuery["sort"]): SQL[] {
  switch (sort) {
    case "created_asc":
      return [asc(customers.createdAt), asc(customers.id)];
    case "name_asc":
      return [asc(sql`lower(${customers.name})`), asc(customers.id)];
    case "name_desc":
      return [desc(sql`lower(${customers.name})`), desc(customers.id)];
    default:
      return [desc(customers.createdAt), desc(customers.id)];
  }
}
