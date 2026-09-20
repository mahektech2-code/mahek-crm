-- WHERE A SHOP IS, AS A TREE SOMEBODY CAN PICK DOWN — and read off the book
-- rather than typed into it.
--
-- The problem this answers is one column. `customers.city` holds 1,165
-- distinct strings across 5,925 shops: 675 of them name exactly one shop, 355
-- contain a comma because the sheet dropped whole postal addresses into it,
-- and the duplicates are the ordinary kind — bhiwendi 55 beside bhiwandi 49,
-- bhubaneshwar 71 beside bhubaneswar 39, "jabalpur, madhya pradesh, india" 78
-- sitting apart from plain Jabalpur. `customers.region` is better, 24 strings
-- for about 20 states, and `india-states.ts` already folds it. Below those two
-- there is nothing at all: `beat`, `area` and `territory_region` are empty on
-- every one of the 5,925 rows and always have been.
--
-- So a journey is proposed by typing into a free-text box against a flat
-- datalist of whatever the sheet happened to spell, a territory is allocated
-- by comparing that same text, and there is no third rung to allocate an area
-- with because no column has ever held one.
--
-- WHY NOT CLEAN THE COLUMN. `party-projection-service.ts` and
-- `customer-master-projection-service.ts` both rewrite `city` and `region`
-- from the sheet on every pass, and neither is decision-guarded the way the
-- manager seats are. A corrected row is overwritten within half an hour. That
-- is the `sales_person_name` failure this codebase already records, where
-- holding the id and letting the name revert was the worst outcome available,
-- and it is why `india-states.ts` chose to normalise on read instead.
--
-- So the sheet keeps writing the raw text and the resolved place is a DERIVED
-- CACHE beside it, rebuilt by a job, exactly like every other derived value
-- here. Nothing below replaces a column; everything below sits next to one.

-- ─────────────────────────────────────────────────────── the master itself
--
-- FOUR RUNGS: state → district → city → area. The district and the city are
-- often the same word and are still two rungs, because where they differ they
-- differ enormously — this book carries Kandivali, Dombivali, Mira Road and
-- Nalasopara as separate cities with 37 to 92 shops each and one district
-- above all four. A territory is allocated in districts and a day is walked in
-- cities, and neither rung can do the other's job.
--
-- EVERY NODE HAS SHOPS BEHIND IT BY CONSTRUCTION, because the tree is built
-- from where the shops actually are rather than from a list of Indian
-- geography. That is the rule `knownPlaces` already follows and states: a
-- separate list would offer places no customer is in, and a territory that
-- matches nothing is a book that goes quietly empty.
CREATE TABLE IF NOT EXISTS "places" (
  "id" text PRIMARY KEY NOT NULL,
  -- state | district | city | area. Text rather than an enum: a value added to
  -- an enum may not be USED in the transaction that adds it and drizzle-kit
  -- runs every pending migration in one, so a fifth rung would fail only on a
  -- database built from scratch — which is CI, and never the machine it was
  -- written on.
  "kind" text NOT NULL,
  -- As shown. The first spelling seen wins, and nothing rewrites it.
  "name" text NOT NULL,
  -- The fold two spellings share — letters and digits, lower case. What a
  -- match compares on, so "Mira Road" and "mira road" are one node.
  "key" text NOT NULL,
  -- What this was picked UNDER. Null on a state, which is the top of the tree.
  -- A real self-reference rather than the empty string `mbos_user_territories`
  -- uses, because that column stores a NAME and this stores an ID: a parent
  -- that can be deleted out from under its children is the one thing an id
  -- must not allow.
  "parent_id" text REFERENCES "places"("id") ON DELETE CASCADE,
  -- How many shops resolve to this node. A CACHE, rebuilt by the same job that
  -- builds the tree — the picker prints it, because a city of 1 is usually a
  -- typo and a district of 400 is where somebody means to start.
  "shops" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- TWO INDEXES FOR ONE RULE, because Postgres treats two NULLs as distinct and
-- would otherwise let the same state be created twice. The partial one covers
-- the top of the tree, the other covers everything under it.
CREATE UNIQUE INDEX IF NOT EXISTS "places_root_key"
  ON "places" ("kind", "key") WHERE "parent_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "places_child_key"
  ON "places" ("kind", "key", "parent_id") WHERE "parent_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "places_parent_idx" ON "places" ("parent_id", "kind");

-- ──────────────────────────────────────────── what one shop's answer WAS
--
-- The raw geocoder answer, kept per shop, and the reason it is kept is the
-- lesson the Taken Order tab already taught: a hash-driven sync re-reads
-- nothing when the RULE changes, so 294 rows stayed muted on the strength of a
-- decision already reversed in the code. Reverse-geocoding costs a request per
-- shop against somebody else's rate limit; re-reading what is stored costs
-- nothing. Without this table, improving how an answer is READ would mean
-- spending 4,930 requests to find out whether the improvement helped.
--
-- A SHOP IS ASKED ONCE, and `looked_up_at` is stamped whether or not an answer
-- came back, so a run does not spend its budget re-asking the unanswerable —
-- the discipline `geocode-job-service.ts` already keeps one table over.
CREATE TABLE IF NOT EXISTS "customer_place_lookups" (
  "customer_id" text PRIMARY KEY NOT NULL
    REFERENCES "customers"("id") ON DELETE CASCADE,
  -- gps | geocode | pincode — WHICH EVIDENCE was asked, not how good it is.
  -- A field pin and a geocoded address are both coordinates and are not the
  -- same claim: one is somebody standing in the shop and the other is Ola's
  -- reading of a line of text, which outside the metros is the centre of a
  -- locality and can be several hundred metres from the door.
  "source" text NOT NULL,
  "lat" double precision,
  "lng" double precision,
  -- Exactly what came back. A parse is a reading of this and can be redone.
  "raw" jsonb,
  -- False means we asked and got nothing usable. Distinguishable from never
  -- having asked, which is the absence of the row — two different facts about
  -- a shop, and no screen may render them alike.
  "ok" boolean DEFAULT false NOT NULL,
  "looked_up_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "customer_place_lookups_source_idx"
  ON "customer_place_lookups" ("source", "ok");

-- ───────────────────────────────────────── where the resolution lands
--
-- Four ids rather than one, so a screen can ask its own question: the
-- territory picker wants the district, the journey picker wants the city, and
-- a report wants to group by the state without walking a parent chain in
-- eleven places.
--
-- NULLABLE, every one of them, and that is the point. A shop with no pin and
-- no address resolves to nothing, and nothing is the honest answer — forcing
-- it into the state its typed text happens to name would put a guess in a
-- column every screen reads as a fact. An unresolved shop is counted and shown
-- rather than hidden, the same rule `statelessShops` already follows.
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "resolved_state_id" text REFERENCES "places"("id"),
  ADD COLUMN IF NOT EXISTS "resolved_district_id" text REFERENCES "places"("id"),
  ADD COLUMN IF NOT EXISTS "resolved_city_id" text REFERENCES "places"("id"),
  ADD COLUMN IF NOT EXISTS "resolved_area_id" text REFERENCES "places"("id"),
  -- gps | geocode | pincode | manual — how this row's answer was arrived at,
  -- carried so a screen can draw a hand-mapped row differently from a
  -- surveyed one rather than presenting a judgement as a measurement.
  ADD COLUMN IF NOT EXISTS "place_source" text,
  ADD COLUMN IF NOT EXISTS "place_resolved_at" timestamp with time zone,
  -- A PERSON CHOSE THIS, and the rebuild leaves it alone.
  --
  -- The third mark of its kind after `orders.approved_at` and
  -- `customers.am_decided_at`, and it guards the same thing they do: a job
  -- that runs every night must not quietly undo somebody's decision. Two
  -- columns rather than reading `place_source = 'manual'` for both jobs,
  -- because they answer different questions — the source says HOW to read the
  -- figure and this says WHETHER anything may touch it, which is exactly the
  -- split `bills.payment_position` and `bills.payment_decided_at` already
  -- keep one module over.
  ADD COLUMN IF NOT EXISTS "place_decided_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "place_decided_by_id" text REFERENCES "users"("id");

CREATE INDEX IF NOT EXISTS "customers_resolved_district_idx"
  ON "customers" ("resolved_district_id");
CREATE INDEX IF NOT EXISTS "customers_resolved_city_idx"
  ON "customers" ("resolved_city_id");
