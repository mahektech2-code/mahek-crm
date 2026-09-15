-- HOW MUCH THE PHONE IS STILL HOLDING, which nothing could see.
--
-- Every fix a handset takes goes into a local queue and stays there until the
-- server confirms it. That is the right design and it is why nothing is ever
-- lost to a bad connection — but it means a phone can be perfectly healthy,
-- reporting its battery, answering every heartbeat, and sitting on fourteen
-- thousand unsent positions, with no screen anywhere able to say so. The only
-- way to find out today is to read `mbos_positions` and notice the newest row
-- is hours old, which is archaeology rather than a dashboard.
--
-- It is the number that answers the question managers actually ask, which is
-- not "is he tracking" but "is his day going to reach me". A backlog draining
-- is fine; a backlog growing for six hours is a support call.
--
-- NULLABLE, and staying that way, for the reason 0122 and 0124 both give: an
-- APK cannot be recalled, so every handset already in the field reports none of
-- this for as long as it is out there. Null has to keep meaning "this build
-- does not say" and never be read as zero — a phone holding nothing and a phone
-- that cannot tell us are different facts, and drawing the second as "clear"
-- is the reassuring answer on the row that has earned it least.
alter table "mbos_devices" add column if not exists "queued_positions" integer;

-- WHEN THAT COUNT WAS TRUE, on our clock and never the handset's.
--
-- The same rule `device_state_at` follows one column along: a phone's clock is
-- its owner's to set, and a queue depth with no age is read as "now" — which
-- on a handset that last spoke at breakfast would have somebody chasing a
-- backlog that has long since drained. The check constraint is what stops a
-- count arriving without one.
alter table "mbos_devices" add column if not exists "queued_positions_at" timestamptz;

alter table "mbos_devices" drop constraint if exists "mbos_devices_queue_depth_dated";
alter table "mbos_devices" add constraint "mbos_devices_queue_depth_dated"
  check ("queued_positions" is null or "queued_positions_at" is not null);
