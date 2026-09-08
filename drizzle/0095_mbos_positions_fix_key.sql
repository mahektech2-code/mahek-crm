-- A position IS its reading, so the same reading is one row.
--
-- The handset minted a fresh UUID for every fix it stored, including for a fix
-- it had already stored: Android redelivers a batch of deferred locations
-- whenever the background task does not complete, so neither `INSERT OR IGNORE`
-- on the phone nor `onConflictDoNothing` here had anything to conflict on.
-- Production carried ~33,000 rows for ~4,000 real fixes, one of them 93 times
-- across 92 separate uploads — which is also why the Live map was hours behind:
-- the queue drains oldest-first, so the duplicates sat in front of the present.
--
-- Collapse them first (a unique index cannot be built over a table that already
-- violates it), keeping the copy that arrived first. Both statements are
-- idempotent, so a re-run is a no-op.
DELETE FROM mbos_positions a
      USING mbos_positions b
      WHERE a.user_id = b.user_id
        AND a.at      = b.at
        AND a.lat     = b.lat
        AND a.lng     = b.lng
        AND a.ctid    > b.ctid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mbos_positions_fix_key
    ON mbos_positions (user_id, at, lat, lng);
