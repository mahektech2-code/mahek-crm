-- The distance a visit's check-in was from the shop's own pin, kept whatever
-- the outcome, plus the mark of a manager overriding a mismatch.
--
-- `handleVisit` already computes this metres figure to decide `verified` and
-- `locationMismatch`, then discarded it once it had been folded into
-- `unverifiedReason`'s sentence — so no screen could ever show the number
-- itself, and never for a visit that verified cleanly. This column is that
-- same figure, kept.
ALTER TABLE mbos_visits ADD COLUMN distance_from_shop_m integer;
ALTER TABLE mbos_visits ADD COLUMN accepted_at timestamp with time zone;
ALTER TABLE mbos_visits ADD COLUMN accepted_by_id text;
