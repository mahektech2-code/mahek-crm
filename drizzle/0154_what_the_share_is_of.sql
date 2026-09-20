-- What collection and activity are a SHARE OF, carried on the cache.
--
-- Both targets are a percentage of a base: collection of what was already
-- overdue at the start of the month, activity of the tasks that fell due in it.
-- `sales_performance` stored the implied rupee/task target and the numerator,
-- and never the base — so a screen reading the cache can print "₹2.4L · 73%"
-- and has no way to say 73% of what.
--
-- The web reads live actuals and already has both figures; this is for the
-- HANDSET, which reads nothing but this row. Nullable, because every row
-- written before this has no base recorded and a zero there would read as
-- "nothing was overdue" — which is a claim about somebody's month, not an
-- absence of data. The next recompute fills them in.
alter table "sales_performance"
  add column if not exists "collection_base_paise" bigint,
  add column if not exists "activity_assigned" integer;
