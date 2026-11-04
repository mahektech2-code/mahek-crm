-- The Live map's team read asks "every fix taken today, by anybody", and the
-- only index on the table leads with user_id, so it scanned the whole table:
-- 567k rows and the most expensive statement in production. This lets it read
-- one day.
CREATE INDEX IF NOT EXISTS "mbos_positions_at_idx" ON "mbos_positions" ("at");
