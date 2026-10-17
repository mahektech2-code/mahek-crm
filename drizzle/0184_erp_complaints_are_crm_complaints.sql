-- ERP simplification, the complaints phase: the ERP's "customer requests" ARE
-- the CRM's complaints. `erp_requests` held the same fields as `complaints`
-- in a second table, so a complaint raised in the ERP never reached the
-- telecaller, and credit notes lived in two ledgers.

-- 1. The two things an ERP request carried that a complaint did not.
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "salesman_name" text;
--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN IF NOT EXISTS "cn_date" date;
--> statement-breakpoint

-- 2. Every ERP request becomes a complaint under the SAME id, so its
--    photographs, its AI suggestions and anything that named it still point
--    at it. The category, status and credit-note status are built as TEXT and
--    cast once per row: an enum value written as a literal would be refused on
--    a database built from nothing, where every migration runs in one
--    transaction and a value appended earlier in it may not be used.
--    A request's credit note was recorded in the ERP only — never in the
--    ledger — so a carried-over one is `issued` with its number and date and
--    nothing is posted: posting it now would move a customer's balance on the
--    strength of a migration. Whoever raised it logged it; failing that, the
--    first administrator, so a request with no author is not lost.
INSERT INTO "complaints" (
  "id", "customer_id", "logged_by_user_id", "category", "description", "severity",
  "status", "sla_due_at", "request_cn", "bill_id", "goods_description", "cn_amount",
  "cn_status", "cn_reference", "cn_date", "mobile_number", "salesman_name",
  "resolution_notes", "resolved_at", "created_at", "updated_at", "created_by_id", "updated_by_id"
)
SELECT r."id",
       r."customer_id",
       coalesce(r."created_by_id", r."approved_by_id", (select u."id" from "users" u where u."role"::text = 'admin' order by u."created_at" limit 1)),
       (CASE lower(trim(coalesce(r."complaint_type", '')))
          WHEN 'packaging' THEN 'packaging_damage'
          WHEN 'staff' THEN 'service'
          WHEN 'product' THEN 'product_quality'
          WHEN 'product complain' THEN 'product_quality'
          WHEN 'product complaint' THEN 'product_quality'
          WHEN 'transport' THEN 'delivery'
          WHEN 'transportation' THEN 'delivery'
          WHEN 'rate discount' THEN 'pricing'
          WHEN 'immediate payment' THEN 'billing_issue'
          ELSE 'other'
        END)::text::"complaint_category",
       coalesce(nullif(trim(r."description"), ''), coalesce(r."complaint_type", 'Customer request') || ' (no description was written)'),
       'medium'::text::"severity",
       (CASE
          WHEN r."status" = 'Rejected' THEN 'rejected'
          WHEN r."status" = 'Accepted' AND r."resolved_at" IS NOT NULL THEN 'resolved'
          WHEN r."status" = 'Accepted' THEN 'in_progress'
          ELSE 'open'
        END)::text::"complaint_status",
       r."raised_at" + interval '48 hours',
       r."cn_required",
       (select b."id" from "bills" b where b."customer_id" = r."customer_id" and b."bill_no" = r."bill_no" limit 1),
       r."goods",
       r."cn_amount_paise",
       (CASE
          WHEN NOT r."cn_required" THEN NULL
          WHEN r."status" = 'Rejected' THEN 'rejected'
          WHEN r."cn_number" IS NOT NULL THEN 'issued'
          WHEN r."status" = 'Accepted' THEN 'under_review'
          ELSE 'requested'
        END)::text::"credit_note_status",
       r."cn_number",
       r."cn_date",
       r."mobile",
       r."salesman_name",
       nullif(concat_ws(' · ',
         nullif(r."remark", ''),
         CASE WHEN r."responsible" IS NOT NULL THEN 'Responsible: ' || r."responsible" END,
         CASE WHEN r."bill_no" IS NOT NULL AND NOT EXISTS (select 1 from "bills" b where b."customer_id" = r."customer_id" and b."bill_no" = r."bill_no")
              THEN 'ERP bill ' || r."bill_no" END), ''),
       r."resolved_at",
       r."raised_at",
       r."updated_at",
       r."created_by_id",
       r."created_by_id"
  FROM "erp_requests" r
 WHERE coalesce(r."created_by_id", r."approved_by_id", (select u."id" from "users" u where u."role"::text = 'admin' order by u."created_at" limit 1)) IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- The opening line of each carried complaint's history, as `createComplaint` writes.
INSERT INTO "complaint_status_history" ("id", "complaint_id", "from_status", "to_status", "changed_by_id", "note", "at")
SELECT 'csh_' || substr(md5(c."id" || '|carried'), 1, 12), c."id", NULL, c."status", c."logged_by_user_id",
       'Carried over from the ERP''s customer requests', c."created_at"
  FROM "complaints" c
  JOIN "erp_requests" r ON r."id" = c."id"
 WHERE NOT EXISTS (select 1 from "complaint_status_history" h where h."complaint_id" = c."id")
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- 3. The request's files are the complaint's now, and read under its rules.
UPDATE "attachments" a
   SET "parent_type" = 'complaint'::text::"attachment_parent"
  FROM "complaints" c
 WHERE a."parent_type"::text = 'erp_request' AND a."parent_id" = c."id";
--> statement-breakpoint
UPDATE "erp_ai_suggestions" SET "record_type" = 'complaint' WHERE "record_type" = 'erp_request';
--> statement-breakpoint

-- 4. A line's credit note is read where it is — the complaint — not copied
--    onto the order line by a "Credit Note Updater".
ALTER TABLE "erp_order_details" DROP COLUMN IF EXISTS "credit_note_paise";
--> statement-breakpoint

-- 5. Issue credit note, Customer complaints and Pending CN were screens; the
--    first two are tabs of Complaints & credit notes and Pending CN is gone.
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|erp.requests'), 1, 16), m."user_id", m."app", 'erp.requests', m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'erp' AND m."module" IN ('erp.issueCn', 'erp.complaints', 'erp.pendingCn')
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|erp.dashboard'), 1, 16), m."user_id", m."app", 'erp.dashboard', m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'erp'
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "app_module_access"
 WHERE "app"::text = 'erp' AND "module" IN ('erp.issueCn', 'erp.complaints', 'erp.pendingCn');
