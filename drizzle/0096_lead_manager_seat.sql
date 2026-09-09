-- The Lead Manager: a second seat on a lead, and the reason it is a second
-- seat rather than a reassignment.
--
-- The client's flow says the Sales Manager becomes Lead Manager once a lead is
-- qualified, "and the salesman remains responsible for field visits". Those two
-- sentences cannot both be true of one column: a lead's owner IS its handset
-- scope — `ASSIGNED_TO_SQL` reads `owner_id` for a lead and `customerIdsInScope`
-- filters the whole book on it — so moving the owner takes the lead off the
-- phone of the person who was just told to keep visiting it.
--
-- So the owner does not move. This is the coordinating seat beside it, and it
-- is read by `scopedToUsers` (who may SEE this record) and deliberately not by
-- `ASSIGNED_TO_SQL` (whose book it is). That is the same split the back office
-- seat already lives under, for the same reason: two people are responsible for
-- one account and both need it on their list.
alter table "customers"
  add column if not exists "lead_manager_id" text references "users"("id");

-- Who it was BEFORE anybody decided, kept for the same reason
-- `sales_manager_person_name` is: the org chart answer is derivable, a person's
-- override is not, and a null here means nobody has overridden anything.
alter table "customers"
  add column if not exists "lead_manager_decided_at" timestamptz;

-- The hot query is "leads waiting on me", which is this seat plus an open
-- stage. Partial, because it is only ever asked of leads.
create index if not exists "customers_lead_manager_idx"
  on "customers" ("lead_manager_id", "lead_stage")
  where "lead_stage" is not null;
