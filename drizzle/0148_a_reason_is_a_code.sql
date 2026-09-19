-- Mahek's round-two answers: three facts that were free text and should be
-- countable, and one that had nowhere to live.
--
-- WHY A CODE AND NOT A SENTENCE, every time this comes up: "how many leads did
-- we park for a plant shutdown this quarter" is a question somebody can ask of
-- a code and cannot ask of a grep. The free-text column stays beside each one
-- and keeps its job — the code says WHICH, the words say what actually
-- happened — and on `other` the words become mandatory, because a code that
-- means "something else" with nothing after it is the row nobody can act on.

-- §— WHY A LEAD WAS PARKED. Six reasons, in the registry so Mahek can reword
-- them without a deploy. `lead_hold_reason` keeps the remarks.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_hold_reason_code" text;

-- §— WHY A TRIAL WAS CALLED OFF. Eight reasons, and the point of them is that
-- they separate three different problems wearing one word: a product we could
-- not source is a SUPPLY problem, a customer who stopped answering is a
-- CUSTOMER problem, and a price objection is a SALES problem. One free-text
-- column could not tell management which of the three it was looking at.
ALTER TABLE "mbos_samples" ADD COLUMN IF NOT EXISTS "cancel_reason_code" text;

-- §3.4 — WHAT THE CUSTOMER SAID THEY WOULD TAKE.
--
-- A commitment has needed a date and a value, and Mahek's answer is that a
-- date ALONE is not a commitment: it wants the day AND how much, as a quantity
-- or a value. There was a column for the value and none for the quantity, so
-- "500 litres around the 25th" could only be recorded by converting it to
-- money nobody had quoted.
--
-- CANS, because cans are what a customer says and what every other quantity in
-- this product stores; litres are derived from the SKU's own packing. At
-- commitment there is often no SKU yet, which is why this may be null and the
-- value may carry the answer instead — either satisfies the rule, neither on
-- its own with no date does.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "lead_expected_order_cans" integer;

-- NOTHING IS BACKFILLED. A commitment recorded before today has whatever it
-- has; inventing a quantity for it would be putting a figure nobody said into
-- a forecast, and reading an old park's sentence into one of six codes would be
-- guessing which of six somebody meant months later. Both read exactly as they
-- always have.
