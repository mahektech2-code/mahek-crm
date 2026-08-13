-- The date written on the cheque, and the two settlements that are not money.
--
-- A cheque handed over on the 3rd and dated the 20th cannot reach the bank
-- until the 20th, however firmly it is in our hands. `received_at` answers
-- when we got it; this answers when it can be banked. Two questions, and
-- collapsing them into one loses whichever answer somebody needed — accounts
-- cannot tell a cheque due this morning from one dated next month, and the
-- customer cannot be spared a chase they do not deserve.
--
-- Past and future are both ordinary and neither is bounded. One dated next
-- month is a post-dated cheque; one dated last week is the kind that goes
-- quiet in a drawer until somebody notices, which is exactly what the accounts
-- list now flags.
ALTER TABLE "payment_receipts" ADD COLUMN "instrument_date" date;--> statement-breakpoint

-- `Credit note` joins the payment modes.
--
-- Neither it nor `Adjustment` is money arriving: one settles a bill against
-- goods returned or a claim allowed, the other against something already on
-- the account. Both close a bill exactly the way a transfer does, and leaving
-- them off the list is how they get recorded as cash nobody can find in the
-- bank statement afterwards.
--
-- A default in the registry is not enough on its own. `seedConfig` writes a
-- row for every setting the first time it runs, so a deployment that has been
-- seeded carries a stored list that would win over the new default for ever.
--
-- What this must NOT do is overwrite somebody's decision. `updated_by_id` is
-- null on a row `seedConfig` wrote and carries an actor id on anything saved
-- from the Settings screen, so this matches a stored value nobody has touched
-- AND the value still being exactly the previous default. A team that has
-- curated its own list of modes is left completely alone — including one that
-- deliberately removed a mode, which appending to would silently put back.
UPDATE "app_settings"
   SET "value" = '["Bank transfer","UPI","Cheque","Cash","Adjustment","Credit note"]'::jsonb
 WHERE "key" = 'payments.modes'
   AND "updated_by_id" IS NULL
   AND "value" = '["Bank transfer","UPI","Cheque","Cash","Adjustment"]'::jsonb;
