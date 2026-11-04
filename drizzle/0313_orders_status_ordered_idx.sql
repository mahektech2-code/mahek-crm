-- The Accounts header badge, the launcher tile, the queue urgency strip and
-- the Accounts home ask about orders still pending approval, on every
-- navigation. No index led with status, so each one read every order ever
-- taken (11.7k and growing) to find the ~250 waiting.
--
-- Not a partial index on status = 'pending_approval': drizzle-kit applies
-- every pending migration in one transaction, and an enum value added earlier
-- in that transaction cannot be used in it, so a fresh database refuses the
-- literal. Leading with status reaches the same rows.
CREATE INDEX IF NOT EXISTS "orders_status_ordered_idx" ON "orders" ("status", "ordered_at") INCLUDE ("total_amount");
