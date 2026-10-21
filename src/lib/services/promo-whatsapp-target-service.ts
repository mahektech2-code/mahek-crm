import "server-only";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { promoWhatsappTargetWhere } from "@/lib/promo-feed-sql";
import { shapeWhatsappTarget, type NormalizeOptions, type PromoWhatsappTarget } from "@/lib/promo-whatsapp-target";

/* ---------------------------------------------------------------------------
 * Reads ONE lost lead's WhatsApp target for the Promotional App. READ ONLY: this file only selects (a test reads this source and
 * fails if it ever gains a write).
 *
 * THIS IS THE ONLY FILE THAT READS A PHONE COLUMN FOR THE PROMOTIONAL APP. The list, facets and by-id service
 * (`promo-feed-service.ts`) select no phone column, and a test fails if any file other than this one starts to. It selects the two
 * number columns and the flags, nothing else, for one id, under the lost scope (a lost, unarchived, untrashed lead).
 *
 * Eligibility is decided in the query AND again on the row that came back (`shapeWhatsappTarget`), at request time, so a lead
 * marked Do Not Contact or WhatsApp Do Not Disturb a moment ago gets no number. Nothing is cached.
 * ------------------------------------------------------------------------- */

const TARGET_COLUMNS = {
  id: customers.id,
  kind: customers.kind,
  leadStage: customers.leadStage,
  leadArchived: customers.leadArchived,
  deletedAt: customers.deletedAt,
  doNotContact: customers.doNotContact,
  whatsappDnd: customers.whatsappDnd,
  whatsappPhone: customers.whatsappPhone,
  phone: customers.phone,
};

/** The target for one id, or null when the lost scope has no such lead. The number inside it is null unless the lead is eligible and the number is usable. */
export async function getPromoWhatsappTarget(id: string, options: NormalizeOptions = {}): Promise<PromoWhatsappTarget | null> {
  const [row] = await db.select(TARGET_COLUMNS).from(customers).where(promoWhatsappTargetWhere(id)).limit(1);
  return row ? shapeWhatsappTarget(row, options) : null;
}
