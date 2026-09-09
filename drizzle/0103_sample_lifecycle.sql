-- §I, §J and §K — a sample from the request to the verdict.
--
-- The table tracked a request, a handover and an outcome. What it could not say
-- is the part §J is entirely about: whether the thing ever actually reached the
-- customer, and whose word that is.

-- WE SENT IT. Our own claim, and distinct from `delivered_at` below.
--
-- A sample handed over by the salesman standing in the shop has these two equal.
-- One put on a lorry has a dispatch date and no delivery for two days, and the
-- gap between them is the only thing that says whether the transport is the
-- problem. Collapsing them made a sample in transit indistinguishable from one
-- nobody had picked up.
alter table "mbos_samples" add column if not exists "dispatched_at" timestamptz;
alter table "mbos_samples" add column if not exists "courier_name" text;
alter table "mbos_samples" add column if not exists "tracking_number" text;

-- THEY CONFIRMED IT. The customer's word, and the third of three.
--
-- The same discipline `payment_receipts` already keeps: what we did, what the
-- carrier says, and what the other party confirms are three assertions by three
-- parties and no two of them are the same fact. `delivered_at` is our side
-- saying it went; this is the shop saying it came. §J turns on exactly that
-- difference — "sample received Yes/No; if No the follow-up remains pending" —
-- and a single date could never answer it.
--
-- Null is a real answer and means the follow-up is still open. It is NOT
-- defaulted from `delivered_at`, because a default would quietly assert
-- something nobody asked the customer.
alter table "mbos_samples" add column if not exists "received_at" timestamptz;
alter table "mbos_samples" add column if not exists "received_reported_by_id"
  text references "users"("id");

-- §K — the trial itself, which is what the sample was for.
--
-- Started and completed are two dates because the gap is the review window: a
-- trial started and never finished is the commonest way a sample goes quiet,
-- and it is invisible if the only column is an outcome.
alter table "mbos_samples" add column if not exists "trial_started_at" timestamptz;
alter table "mbos_samples" add column if not exists "trial_completed_at" timestamptz;
alter table "mbos_samples" add column if not exists "satisfaction" text;
alter table "mbos_samples" add column if not exists "additional_requirement" text;

-- Mandatory on a rejection, enforced in `handleSampleUpdate` rather than by a
-- constraint: the column is null on every sample that has not been decided, and
-- a check constraint would have to encode the outcome as well as the reason.
alter table "mbos_samples" add column if not exists "rejection_reason" text;

-- The two lists this table is read as: what has been sent and not confirmed
-- received, and what is on trial and due a review call.
create index if not exists "mbos_samples_in_transit_idx"
  on "mbos_samples" ("dispatched_at")
  where "received_at" is null;
