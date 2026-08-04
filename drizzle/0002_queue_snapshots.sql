CREATE TABLE "queue_snapshots" (
	"day" date NOT NULL,
	"customer_id" text NOT NULL,
	"user_id" text,
	CONSTRAINT "queue_snapshots_day_customer_id_pk" PRIMARY KEY("day","customer_id")
);
--> statement-breakpoint
ALTER TABLE "queue_snapshots" ADD CONSTRAINT "queue_snapshots_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_snapshots" ADD CONSTRAINT "queue_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_snapshots_day_idx" ON "queue_snapshots" USING btree ("day");