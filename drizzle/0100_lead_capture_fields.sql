-- What a salesman actually learns standing in the shop, and had nowhere to put.
--
-- The lead form captured a name, a company, a mobile, a town, a source, a guess
-- at what the account could be worth, and a note. The client's §A and §C ask for
-- nine more things, and four of them already had columns on `customers` —
-- `address`, `gps_lat`/`gps_lng`, `customer_type` and `gstin` — which the lead
-- path simply never wrote. These three are the ones with nowhere to go at all.

-- What they want to buy, in their own words. Free text rather than a product id:
-- a shop says "thinner for a spray booth", and pinning that to a SKU at capture
-- would be the salesman guessing on the customer's behalf.
alter table "customers"
  add column if not exists "lead_requirement" text;

-- How much they get through in a month.
--
-- LITRES, and not cans. Everywhere else in MahekOne a quantity is cans, because
-- cans are what the telecaller counts and what the customer says when ordering —
-- and litres are derived from the SKU's own packing. There is no SKU here. A
-- prospect says "we use about two hundred litres a month" before anybody knows
-- what they will buy it as, so litres is the only unit the sentence survives in.
alter table "customers"
  add column if not exists "lead_monthly_volume_litres" integer;

-- Who actually signs. Distinct from `contact_person`, which is whoever answers
-- the phone — on the accounts this matters for they are routinely not the same
-- person, and turning up to negotiate with the wrong one is the visit wasted.
alter table "customers"
  add column if not exists "lead_decision_maker" text;

-- A photograph of the shop, taken at capture.
--
-- Its own parent kind rather than borrowing `mbos_visit`, because `canRead`
-- decides who may open a file FROM the parent kind — and a lead has no visit
-- behind it at the moment the photograph is taken. A lead IS a `customers` row,
-- so this one resolves straight through the customer's own scope.
--
-- Added here and USED only by application code that runs after this commits.
-- Postgres refuses to use an enum value in the transaction that adds it and
-- drizzle-kit applies every pending migration in one, so no later migration in
-- this batch may insert a row carrying it — see the note on `app_id` in
-- AGENTS.md, which is the same rule that made `npm run app:grant` necessary.
alter type "attachment_parent" add value if not exists 'mbos_lead';
