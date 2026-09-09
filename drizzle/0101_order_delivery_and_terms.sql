-- §L, §M and §N — the negotiation's outcome, and what happens to an order
-- after somebody agrees to it.

-- §N. The status stopped at `dispatched`, which is us saying it left the
-- godown. Everything §N asks for happens after that.
--
-- Added here and used only by application code that runs after this commits —
-- Postgres refuses to use an enum value in the transaction that adds it and
-- drizzle-kit applies every pending migration in one, so no later migration in
-- this batch may write either. Same rule as `app_id` and `mbos_lead_stage`.
alter type "order_status" add value if not exists 'in_transit';
alter type "order_status" add value if not exists 'delivered';

-- §M — the customer's own confirmation, which is not our approval.
--
-- `status = 'confirmed'` is ACCOUNTS accepting the order: they checked the
-- credit and said we will supply it. This is the other party agreeing to what
-- was written down. The two are routinely days apart and either can happen
-- first, so one column could never have carried both.
alter table "orders" add column if not exists "customer_confirmed_at" timestamptz;
-- How they confirmed it — read back on the call, a WhatsApp reply, a signature
-- on the copy. Free text, because the honest answer is usually a sentence.
alter table "orders" add column if not exists "customer_confirmed_note" text;

-- §N — and the customer's own confirmation that the goods came.
--
-- The third assertion again, exactly as on a sample: we dispatched it, the
-- carrier says it arrived, the SHOP says it has it. `delivery_confirmed_at` is
-- the shop's word and is never inferred from the status.
alter table "orders" add column if not exists "delivery_confirmed_at" timestamptz;
alter table "orders" add column if not exists "delivery_confirmed_by_id"
  text references "users"("id");
-- What actually turned up, where it was not what was sent. Null means nobody
-- reported a discrepancy, which is different from "it was correct" — nobody
-- was asked. A short quantity is a fact about the delivery and belongs beside
-- it rather than only inside a complaint.
alter table "orders" add column if not exists "delivery_discrepancy" text;

-- §L — what was agreed, once negotiation is open.
--
-- On the customer rather than the order: terms are the standing arrangement a
-- salesman negotiated, and the first order is priced under them rather than
-- carrying them. A DISCOUNT that needs authorising still goes through
-- `mbos_approvals`, which already exists for exactly that — this is the record
-- of the position, not a second approval path.
alter table "customers" add column if not exists "lead_delivery_terms" text;
alter table "customers" add column if not exists "lead_agreed_terms" text;

-- The list §N is worked from: what has left and not been confirmed as arrived.
create index if not exists "orders_awaiting_delivery_idx"
  on "orders" ("status")
  where "delivery_confirmed_at" is null;
