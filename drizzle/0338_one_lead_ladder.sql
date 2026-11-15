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
--
-- The writes are EXECUTEd, and only where a row needs one: drizzle-kit applies
-- every pending migration in one transaction, and on a fresh database the enum
-- values named here were added in that same transaction, where Postgres refuses
-- to use them. A fresh database has no leads, so nothing is executed there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "customers" WHERE "lead_stage"::text IN ('new', 'contacted', 'qualified')) THEN
    EXECUTE $q$
      UPDATE "customers"
         SET "lead_stage" = (CASE "lead_stage"::text
               WHEN 'qualified' THEN 'qualification'
               ELSE 'suspect'
             END)::mbos_lead_stage
       WHERE "lead_stage"::text IN ('new', 'contacted', 'qualified')
    $q$;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "customers"
     WHERE "kind" = 'lead' AND "lead_stage" IS NULL AND coalesce("third_party", false) = false
  ) THEN
    EXECUTE $q$
      UPDATE "customers"
         SET "lead_stage" = 'suspect'::mbos_lead_stage,
             "lead_stage_since" = coalesce("lead_stage_since", (now() at time zone 'Asia/Kolkata')::date)
       WHERE "kind" = 'lead'
         AND "lead_stage" IS NULL
         AND coalesce("third_party", false) = false
    $q$;
  END IF;
END $$;
