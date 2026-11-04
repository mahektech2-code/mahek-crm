-- The Accounts header badge, the launcher tile, the queue urgency strip and
-- the Accounts home all ask about orders still pending approval, on every
-- navigation. No index led with status, so each one read every order ever
-- taken (11.7k and growing) to find the ~250 waiting. This holds only those.
CREATE INDEX IF NOT EXISTS "orders_pending_approval_idx" ON "orders" ("ordered_at") INCLUDE ("total_amount") WHERE "status" = 'pending_approval';
