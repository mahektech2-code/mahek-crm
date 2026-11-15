-- ONE LEAD LADDER (Nov 2026).
--
-- Every lead now climbs the same rungs whatever its sales type, and screens draw
-- them as seven stages. Two kinds of row could not be drawn on that ladder:
--
-- 1. Leads still carrying the retired legacy words. `new` and `contacted` are a
--    Suspect, `qualified` is Qualification. `won` is left as written: it is what
--    a conversion records and every reader already treats it as the end.
-- 2. Leads with no stage at all. Every Lead Management screen reads
--    `lead_stage is not null`, and the Customers list leaves leads out, so these
--    were on no screen anywhere. They start at Suspect. A third-party shop is a
--    customer we deliver to, not a lead, and is left alone.
--
-- `lead_stage_transitions` is not touched: history keeps the words it used.
UPDATE "customers"
   SET "lead_stage" = CASE "lead_stage"::text
         WHEN 'new' THEN 'suspect'::mbos_lead_stage
         WHEN 'contacted' THEN 'suspect'::mbos_lead_stage
         WHEN 'qualified' THEN 'qualification'::mbos_lead_stage
       END
 WHERE "lead_stage"::text IN ('new', 'contacted', 'qualified');
--> statement-breakpoint
UPDATE "customers"
   SET "lead_stage" = 'suspect'::mbos_lead_stage,
       "lead_stage_since" = coalesce("lead_stage_since", (now() at time zone 'Asia/Kolkata')::date)
 WHERE "kind" = 'lead'
   AND "lead_stage" IS NULL
   AND coalesce("third_party", false) = false;
