-- Automated WhatsApp, configured by the founder.
--
-- wa_triggers: a rule per template (several allowed) — the day range on the
--   template's own clock, how often it repeats, how many times at most, a
--   minimum amount, a priority, and off / preview / live.
-- wa_automation_settings: when anything may go out at all. Seeded 10:00–13:00
--   IST, Monday to Saturday — Mahek's instruction was nothing after 1 pm.
-- wa_automation_runs: every pass, and what each rule did or would have done.
-- wa_messages.trigger_id: which rule sent a message.
--
-- The eight starter rules are seeded OFF. Their numbers come from settings the
-- collections engine already runs on (stage 1 below 16 days overdue, stage 2
-- from 16, stage 3 from 30, a WhatsApp every 4 days) and are there to be
-- changed; nothing sends until the founder turns a rule to Live.
CREATE TABLE IF NOT EXISTS "wa_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL REFERENCES "wa_templates"("id") ON DELETE cascade,
	"status" text DEFAULT 'off' NOT NULL,
	"from_day" integer NOT NULL,
	"to_day" integer,
	"repeat_every_days" integer NOT NULL,
	"max_sends" integer,
	"min_amount_paise" bigint,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text REFERENCES "users"("id"),
	"updated_by_name" text,
	CONSTRAINT "wa_triggers_status_check" CHECK ("status" in ('off', 'preview', 'live')),
	CONSTRAINT "wa_triggers_range_check" CHECK ("to_day" IS NULL OR "to_day" >= "from_day"),
	CONSTRAINT "wa_triggers_repeat_check" CHECK ("repeat_every_days" >= 1),
	CONSTRAINT "wa_triggers_max_check" CHECK ("max_sends" IS NULL OR "max_sends" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wa_automation_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"window_start_hour" integer DEFAULT 10 NOT NULL,
	"window_end_hour" integer DEFAULT 13 NOT NULL,
	"weekdays" integer[] NOT NULL,
	"daily_cap" integer DEFAULT 300 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text REFERENCES "users"("id"),
	"updated_by_name" text,
	CONSTRAINT "wa_automation_window_check" CHECK ("window_start_hour" >= 0 AND "window_end_hour" <= 24 AND "window_start_hour" < "window_end_hour"),
	CONSTRAINT "wa_automation_cap_check" CHECK ("daily_cap" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wa_automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"dry" boolean NOT NULL,
	"trigger" text NOT NULL,
	"note" text,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_automation_runs_started_idx" ON "wa_automation_runs" USING btree ("started_at" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "wa_messages" ADD COLUMN IF NOT EXISTS "trigger_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wa_messages_trigger_idx" ON "wa_messages" USING btree ("trigger_id", "customer_id");
--> statement-breakpoint
INSERT INTO "wa_automation_settings" ("id", "window_start_hour", "window_end_hour", "weekdays", "daily_cap")
SELECT 'default', 10, 13, ARRAY[1,2,3,4,5,6], 300
WHERE NOT EXISTS (SELECT 1 FROM "wa_automation_settings" WHERE "id" = 'default');
--> statement-breakpoint
INSERT INTO "wa_triggers" ("id", "template_id", "status", "from_day", "to_day", "repeat_every_days", "max_sends", "priority")
SELECT v.id, v.template_id, 'off', v.from_day, v.to_day, v.repeat_every_days, v.max_sends, v.priority
FROM (VALUES
	('trg_payment_followup_1',            'tpl_wati_payment_followup_1',            1,    15,   4,  NULL, 40),
	('trg_payment_statement',             'tpl_wati_payment_statement',             1,    NULL, 30, NULL, 50),
	('trg_payment_followup_urgent',       'tpl_wati_payment_followup_urgent',       16,   29,   4,  NULL, 20),
	('trg_payment_credit_hold',           'tpl_wati_payment_credit_hold',           30,   NULL, 7,  NULL, 10),
	('trg_order_reminder_due',            'tpl_wati_order_reminder_due',            -2,   0,    30, 1,    60),
	('trg_order_followup_due_passed',     'tpl_wati_order_followup_due_passed',     1,    7,    30, 1,    70),
	('trg_order_followup_cycle_exceeded', 'tpl_wati_order_followup_cycle_exceeded', 8,    30,   30, 1,    80),
	('trg_customer_followup_gap',         'tpl_wati_customer_followup_gap',         31,   NULL, 30, 2,    90)
) AS v(id, template_id, from_day, to_day, repeat_every_days, max_sends, priority)
WHERE EXISTS (SELECT 1 FROM "wa_templates" t WHERE t.id = v.template_id)
  AND NOT EXISTS (SELECT 1 FROM "wa_triggers" x WHERE x.id = v.id);
