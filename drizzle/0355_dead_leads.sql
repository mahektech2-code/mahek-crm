-- DEAD LEADS — a permanent, irreversible subset of Lost, approved by the
-- requester's reporting manager.
--
-- NUMBERING: this was developed as 0189 on a branch cut before the journal reached
-- 0354. 0189 and 0188 are taken on main by other migrations, so it is 0355 here;
-- it reads and depends on nothing in them.
--
-- WHAT IT ADDS
--   * customers.lead_dead_at / lead_dead_by_id / lead_dead_request_id — the
--     permanent marker. lead_stage stays 'lost'; Dead is NOT a stage.
--   * lead_dead_requests — one row per ask, kept for ever (rejections too).
--   * Triggers that make "read-only" true of the DATABASE and not only of the
--     screens: a Dead customer's business state cannot be updated, the row
--     cannot be deleted, and no call, visit, order, task, sample, reminder,
--     message, complaint, stage transition or validation can be written
--     against it, by any server action, job or sync.
--
-- Additive only. Nothing existing changes meaning and no row is rewritten.

ALTER TABLE "customers" ADD COLUMN "lead_dead_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "lead_dead_by_id" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "lead_dead_request_id" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_dead_by_id_users_id_fk" FOREIGN KEY ("lead_dead_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE "lead_dead_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"requested_by_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"approver_id" text NOT NULL,
	"requester_employee_id" text,
	"approver_employee_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"lost_reason_at_request" text,
	"lost_from_stage_at_request" text,
	CONSTRAINT "lead_dead_requests_state_check" CHECK ("state" in ('pending', 'approved', 'rejected', 'withdrawn')),
	-- No self-approval: the person asking can never be the person deciding.
	CONSTRAINT "lead_dead_requests_no_self_approval" CHECK ("requested_by_id" <> "approver_id"),
	-- Only the approver the request was routed to may approve or reject it, and
	-- only the person who asked may withdraw it. `decided_by_id` carries whoever
	-- closed it, whichever way.
	CONSTRAINT "lead_dead_requests_decided_by_approver" CHECK (
		"state" = 'pending'
		OR ("state" = 'withdrawn' AND "decided_by_id" = "requested_by_id")
		OR ("state" IN ('approved', 'rejected') AND "decided_by_id" = "approver_id")
	),
	CONSTRAINT "lead_dead_requests_decided_has_time" CHECK ("state" = 'pending' OR "decided_at" IS NOT NULL),
	CONSTRAINT "lead_dead_requests_reject_says_why" CHECK ("state" <> 'rejected' OR length(btrim(coalesce("decision_note", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "lead_dead_requests" ADD CONSTRAINT "lead_dead_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_dead_requests" ADD CONSTRAINT "lead_dead_requests_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_dead_requests" ADD CONSTRAINT "lead_dead_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_dead_requests" ADD CONSTRAINT "lead_dead_requests_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- At most ONE pending request per lead — the duplicate guard, in the database.
CREATE UNIQUE INDEX "lead_dead_requests_one_pending_key" ON "lead_dead_requests" USING btree ("customer_id") WHERE state = 'pending';
--> statement-breakpoint
CREATE INDEX "lead_dead_requests_approver_idx" ON "lead_dead_requests" USING btree ("approver_id","state","requested_at");
--> statement-breakpoint
CREATE INDEX "lead_dead_requests_customer_idx" ON "lead_dead_requests" USING btree ("customer_id","requested_at");
--> statement-breakpoint

-- A request may only be raised about a Lost lead that is not already Dead.
CREATE FUNCTION "lead_dead_requests_guard"() RETURNS trigger AS $$
DECLARE
	c record;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT lead_stage::text AS stage, lead_dead_at INTO c FROM customers WHERE id = NEW.customer_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'That lead does not exist.' USING ERRCODE = 'DL003';
		END IF;
		IF c.lead_dead_at IS NOT NULL THEN
			RAISE EXCEPTION 'This lead is already permanently Dead.' USING ERRCODE = 'DL001';
		END IF;
		IF c.stage IS DISTINCT FROM 'lost' THEN
			RAISE EXCEPTION 'Only a Lost lead can be marked Dead.' USING ERRCODE = 'DL003';
		END IF;
		RETURN NEW;
	END IF;

	-- UPDATE: a decided request is history and never changes again, and what
	-- was asked, by whom, of whom, never changes at all.
	IF OLD.state <> 'pending' THEN
		RAISE EXCEPTION 'A decided Dead request cannot be changed.' USING ERRCODE = 'DL003';
	END IF;
	IF NEW.customer_id <> OLD.customer_id
		OR NEW.requested_by_id <> OLD.requested_by_id
		OR NEW.approver_id <> OLD.approver_id
		OR NEW.reason_code <> OLD.reason_code
		OR NEW.requested_at <> OLD.requested_at THEN
		RAISE EXCEPTION 'A Dead request cannot be re-routed or rewritten.' USING ERRCODE = 'DL003';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "lead_dead_requests_guard_ins" BEFORE INSERT ON "lead_dead_requests"
	FOR EACH ROW EXECUTE FUNCTION "lead_dead_requests_guard"();
--> statement-breakpoint
CREATE TRIGGER "lead_dead_requests_guard_upd" BEFORE UPDATE ON "lead_dead_requests"
	FOR EACH ROW EXECUTE FUNCTION "lead_dead_requests_guard"();
--> statement-breakpoint

-- THE LOCK. A Dead customer's business state cannot change, and the marker
-- itself can never be cleared or moved. The list of columns a system pass may
-- still write is deliberately a short ALLOW-list of derived caches, so a column
-- added later is locked by default rather than open by default.
--
-- A Lost lead also cannot leave Lost while a Dead request is pending: the
-- Reverse Lost doors check this in words, and this is the net under them.
CREATE FUNCTION "customers_dead_lead_lock"() RETURNS trigger AS $$
DECLARE
	cache_columns text[] := ARRAY[
		'updated_at', 'updated_by_id', 'status',
		'cycle_days', 'cycle_is_default', 'cycle_confidence',
		'last_order_date', 'last_order_value', 'last_contact_date', 'last_call_date',
		'last_confirmed_whatsapp_date', 'active_in_order_system', 'outstanding',
		'avg_order_value', 'typical_order_paise', 'slow_payer', 'last_visit_date',
		'health_score', 'health_components', 'health_computed_at',
		'sales_person_name', 'sales_manager_id', 'sales_manager_person_name',
		'geocoded_lat', 'geocoded_lng', 'geocoded_precision', 'geocoded_query', 'geocoded_at',
		'resolved_state_id', 'resolved_district_id', 'resolved_city_id', 'resolved_area_id',
		'place_source', 'place_resolved_at',
		'whatsapp_dnd', 'whatsapp_dnd_reason', 'whatsapp_dnd_at', 'whatsapp_dnd_by_name', 'do_not_contact'
	];
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD.lead_dead_at IS NOT NULL THEN
			RAISE EXCEPTION 'This lead is permanently Dead and cannot be deleted.' USING ERRCODE = 'DL001';
		END IF;
		RETURN OLD;
	END IF;

	IF OLD.lead_dead_at IS NULL THEN
		IF OLD.lead_stage::text = 'lost'
			AND NEW.lead_stage IS DISTINCT FROM OLD.lead_stage
			AND EXISTS (SELECT 1 FROM lead_dead_requests r WHERE r.customer_id = OLD.id AND r.state = 'pending') THEN
			RAISE EXCEPTION 'A Dead request is pending on this lead, so it cannot be reversed until the manager decides.' USING ERRCODE = 'DL002';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW.lead_dead_at IS DISTINCT FROM OLD.lead_dead_at
		OR NEW.lead_dead_by_id IS DISTINCT FROM OLD.lead_dead_by_id
		OR NEW.lead_dead_request_id IS DISTINCT FROM OLD.lead_dead_request_id
		OR (to_jsonb(NEW) - cache_columns) IS DISTINCT FROM (to_jsonb(OLD) - cache_columns) THEN
		RAISE EXCEPTION 'This lead is permanently Dead and read-only. It cannot be changed, reassigned, reopened or converted.' USING ERRCODE = 'DL001';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "customers_dead_lead_lock_upd" BEFORE UPDATE ON "customers"
	FOR EACH ROW WHEN (OLD.lead_dead_at IS NOT NULL OR OLD.lead_stage::text = 'lost')
	EXECUTE FUNCTION "customers_dead_lead_lock"();
--> statement-breakpoint
CREATE TRIGGER "customers_dead_lead_lock_del" BEFORE DELETE ON "customers"
	FOR EACH ROW WHEN (OLD.lead_dead_at IS NOT NULL)
	EXECUTE FUNCTION "customers_dead_lead_lock"();
--> statement-breakpoint

-- NO NEW ACTIVITY against a Dead customer, from any writer. History already
-- written is never touched; only new rows are refused.
CREATE FUNCTION "lead_dead_block_new_activity"() RETURNS trigger AS $$
DECLARE
	cid text := to_jsonb(NEW) ->> 'customer_id';
BEGIN
	IF cid IS NOT NULL AND EXISTS (
		SELECT 1 FROM customers WHERE id = cid AND lead_dead_at IS NOT NULL
	) THEN
		RAISE EXCEPTION 'This lead is permanently Dead and read-only. No new activity can be recorded against it.' USING ERRCODE = 'DL001';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "calls_dead_lead_lock" BEFORE INSERT ON "calls" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "orders_dead_lead_lock" BEFORE INSERT ON "orders" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "mbos_visits_dead_lead_lock" BEFORE INSERT ON "mbos_visits" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "mbos_tasks_dead_lead_lock" BEFORE INSERT ON "mbos_tasks" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "mbos_samples_dead_lead_lock" BEFORE INSERT ON "mbos_samples" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "reminders_dead_lead_lock" BEFORE INSERT ON "reminders" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "complaints_dead_lead_lock" BEFORE INSERT ON "complaints" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "wa_messages_dead_lead_lock" BEFORE INSERT ON "wa_messages" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "lead_stage_transitions_dead_lead_lock" BEFORE INSERT ON "lead_stage_transitions" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "mbos_lead_validations_dead_lead_lock" BEFORE INSERT ON "mbos_lead_validations" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "lead_verification_corrections_dead_lead_lock" BEFORE INSERT ON "lead_verification_corrections" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "mbos_internal_notes_dead_lead_lock" BEFORE INSERT ON "mbos_internal_notes" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "mbos_competitor_records_dead_lead_lock" BEFORE INSERT ON "mbos_competitor_records" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "call_opportunities_dead_lead_lock" BEFORE INSERT ON "call_opportunities" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
--> statement-breakpoint
CREATE TRIGGER "mbos_journey_stops_dead_lead_lock" BEFORE INSERT ON "mbos_journey_stops" FOR EACH ROW EXECUTE FUNCTION "lead_dead_block_new_activity"();
