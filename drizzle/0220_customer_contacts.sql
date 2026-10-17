-- The people at a customer and their numbers, with three designations each held
-- by at most one row per customer: who we ring (primary), where WhatsApp goes,
-- and where a payment reminder goes. The designated rows are MIRRORED onto
-- customers.phone / contact_person / whatsapp_phone / payment_whatsapp_phone by
-- syncContactMirrors, so every existing reader keeps working unchanged.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "payment_whatsapp_phone" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
	"name" text,
	"role" text DEFAULT 'other' NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"note" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"for_whatsapp" boolean DEFAULT false NOT NULL,
	"for_payment_reminders" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
	"updated_by_id" text REFERENCES "users"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_contacts_customer_idx" ON "customer_contacts" ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_contacts_one_primary" ON "customer_contacts" ("customer_id") WHERE "is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_contacts_one_whatsapp" ON "customer_contacts" ("customer_id") WHERE "for_whatsapp";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_contacts_one_payment" ON "customer_contacts" ("customer_id") WHERE "for_payment_reminders";--> statement-breakpoint
-- The book as it stands, carried in: the phone on the record is the primary
-- contact (and the WhatsApp one where the WhatsApp number is the same), a
-- separate WhatsApp number is its own contact, and an alternate number that
-- is neither is a third. Guarded so a re-run adds nothing.
INSERT INTO "customer_contacts" ("id", "customer_id", "name", "role", "phone", "is_primary", "for_whatsapp", "sort_order")
SELECT 'cct_' || substr(md5(c.id || ':primary'), 1, 16), c.id, nullif(trim(c.contact_person), ''), 'other', trim(c.phone), true,
       -- Marked for WhatsApp only where the record SAYS so. A customer with no
       -- WhatsApp number already messages their phone by fallback, and the
       -- screen says that rather than a migration claiming a choice nobody made.
       (nullif(trim(coalesce(c.whatsapp_phone, '')), '') IS NOT NULL
         AND right(regexp_replace(c.whatsapp_phone, '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10)),
       0
FROM "customers" c
WHERE trim(c.phone) <> ''
  AND NOT EXISTS (SELECT 1 FROM "customer_contacts" x WHERE x.customer_id = c.id);--> statement-breakpoint
INSERT INTO "customer_contacts" ("id", "customer_id", "role", "phone", "for_whatsapp", "sort_order")
SELECT 'cct_' || substr(md5(c.id || ':whatsapp'), 1, 16), c.id, 'other', trim(c.whatsapp_phone), true, 1
FROM "customers" c
WHERE nullif(trim(coalesce(c.whatsapp_phone, '')), '') IS NOT NULL
  AND right(regexp_replace(c.whatsapp_phone, '\D', '', 'g'), 10) <> right(regexp_replace(c.phone, '\D', '', 'g'), 10)
  AND NOT EXISTS (SELECT 1 FROM "customer_contacts" x WHERE x.customer_id = c.id AND x.for_whatsapp);--> statement-breakpoint
INSERT INTO "customer_contacts" ("id", "customer_id", "role", "phone", "sort_order")
SELECT 'cct_' || substr(md5(c.id || ':alt'), 1, 16), c.id, 'other', trim(c.alt_phone), 2
FROM "customers" c
WHERE nullif(trim(coalesce(c.alt_phone, '')), '') IS NOT NULL
  AND right(regexp_replace(c.alt_phone, '\D', '', 'g'), 10) <> right(regexp_replace(c.phone, '\D', '', 'g'), 10)
  AND right(regexp_replace(c.alt_phone, '\D', '', 'g'), 10) <> right(regexp_replace(coalesce(c.whatsapp_phone, ''), '\D', '', 'g'), 10)
  AND NOT EXISTS (
    SELECT 1 FROM "customer_contacts" x
    WHERE x.customer_id = c.id
      AND right(regexp_replace(x.phone, '\D', '', 'g'), 10) = right(regexp_replace(c.alt_phone, '\D', '', 'g'), 10)
  );
