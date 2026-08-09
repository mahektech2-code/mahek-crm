CREATE TYPE "public"."receipt_status" AS ENUM('reported', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TABLE "payment_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"received_at" date NOT NULL,
	"mode" text DEFAULT 'Bank transfer' NOT NULL,
	"reference" text,
	"note" text,
	"status" "receipt_status" DEFAULT 'reported' NOT NULL,
	"source" text DEFAULT 'accounts' NOT NULL,
	"reported_by_id" text,
	"confirmed_by_id" text,
	"confirmed_at" timestamp with time zone,
	"reject_reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_by_id" text
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "bill_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "receipt_id" text;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_confirmed_by_id_users_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_receipts_key" ON "payment_receipts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_receipts_customer_idx" ON "payment_receipts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payment_receipts_status_idx" ON "payment_receipts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_receipts_received_idx" ON "payment_receipts" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bills_order_idx" ON "bills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_bill_idx" ON "payments" USING btree ("bill_id");--> statement-breakpoint

/*
 * Every payment already recorded becomes a CONFIRMED receipt.
 *
 * They were taken under the old rule, where recording a payment and believing
 * it were the same act. Re-opening them as "reported" would put settled debt
 * back on live screens and ask accounts to verify a year of history from
 * memory. What was true when the row was written stays true.
 *
 * A collections call that spread one payment over several bills wrote one row
 * per bill sharing an idempotency key prefix — `<key>:<billId>`. That prefix
 * is what the receipt is: one arrival of money, several allocation lines. It
 * is reconstructed here rather than thrown away, so the ledger shows the
 * transfer the customer actually made. Anything without that shape is its own
 * receipt, because nothing in the row says otherwise.
 */
INSERT INTO "payment_receipts" (
  "id", "customer_id", "amount", "received_at", "mode", "reference", "note",
  "status", "source", "reported_by_id", "confirmed_by_id", "confirmed_at",
  "idempotency_key", "created_at", "updated_at"
)
SELECT
  'rcp_' || substr(md5(g.group_key), 1, 16),
  g.customer_id,
  g.amount,
  g.paid_at,
  g.mode,
  g.reference,
  'Recorded before accounts confirmation existed.',
  'confirmed',
  'legacy',
  g.recorded_by_id,
  g.recorded_by_id,
  g.created_at,
  'legacy:' || g.group_key,
  g.created_at,
  now()
FROM (
  SELECT
    CASE
      WHEN p.external_ref LIKE '%:%' THEN split_part(p.external_ref, ':', 1)
      ELSE 'pay:' || p.id
    END AS group_key,
    min(p.customer_id) AS customer_id,
    sum(p.amount) AS amount,
    min(p.paid_at) AS paid_at,
    min(p.mode) AS mode,
    min(p.reference) AS reference,
    min(p.recorded_by_id) AS recorded_by_id,
    min(p.created_at) AS created_at
  FROM "payments" p
  GROUP BY 1
) g;--> statement-breakpoint

UPDATE "payments" p
   SET "receipt_id" = 'rcp_' || substr(md5(
         CASE
           WHEN p.external_ref LIKE '%:%' THEN split_part(p.external_ref, ':', 1)
           ELSE 'pay:' || p.id
         END
       ), 1, 16);--> statement-breakpoint

ALTER TABLE "payments" ALTER COLUMN "receipt_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_receipt_id_payment_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."payment_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_receipt_idx" ON "payments" USING btree ("receipt_id");--> statement-breakpoint

/*
 * Bills and orders were joined only by a naming convention the importer knows
 * about — SHEET-<n> on the order, SHEETPAY-<n> on the bill. Making it a column
 * is what lets accounts find a bill by the order number a customer quotes.
 */
UPDATE "bills" b
   SET "order_id" = o.id
  FROM "orders" o
 WHERE b.external_ref IS NOT NULL
   AND b.external_ref LIKE 'SHEETPAY-%'
   AND o.external_ref = 'SHEET-' || substr(b.external_ref, length('SHEETPAY-') + 1)
   AND b.order_id IS NULL;
