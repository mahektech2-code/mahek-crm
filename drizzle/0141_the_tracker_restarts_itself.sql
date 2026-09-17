-- WHETHER THE HANDSET IS STILL WATCHING ITSELF, and how much reviving it has
-- needed today.
--
-- `tracker_stalled_at` beside these says the phone was CAUGHT with its tracker
-- accepted and silent, and that column has been the end of the story: the
-- handset then gave up for the rest of the app's run and fell back to a
-- JavaScript timer, which only advances while the app is on screen. On a phone
-- in a pocket that is no recording at all. Production handsets show what it
-- costs — fifty-one separate silences inside one working day, 523 minutes lost
-- between them, single gaps of 999, 498, 456 and 437 minutes — every one of
-- them on a handset reporting `location_permission = 'always'`, background
-- granted and location services on.
--
-- The app now starts the tracker again instead, at a rate the office sets, and
-- these two columns are what let anybody see that happening.
--
-- `tracker_watchdog_last_run_at` IS NOT A SECOND COPY OF
-- `background_sync_last_run_at`. That one is the expo-background-task job,
-- which runs by booting the whole JavaScript bundle — so its silence can mean
-- the bundle would not start, the database would not open, or any of a dozen
-- things. This is a native WorkManager worker that touches no bundle at all,
-- and its silence means exactly one thing: the manufacturer has stopped
-- honouring WorkManager for this app. That is a support call of its own and one
-- nothing in MahekOne could previously make.
--
-- It is stamped from a DURATION the handset reports, never an instant it
-- claims, exactly as the two marks beside it are. A phone's clock is its
-- owner's to set, and when a background worker last ran is a fact only the
-- handset holds; seconds-ago survives a clock wrong by hours.
--
-- `tracker_restarts_today` IS A COUNT AND ZERO IS A REAL ANSWER — it means the
-- tracker has not had to be revived today, which is what a healthy phone looks
-- like. NULL is a build that cannot say, which is every handset in the field
-- until the next APK, and the two must never be drawn alike: "0 restarts" on a
-- row where nothing was reported would be the most reassuring mark on the
-- screen sitting on the phone that has earned it least.
--
-- It carries no age column of its own, unlike `queued_positions`. That one
-- needed one because a report can carry a battery reading and no queue depth,
-- so dating the count off `device_state_at` would claim we had been told
-- something we had not. Here the count is meaningless without the day it
-- belongs to, and the day it belongs to is the handset's own local calendar
-- day — so what it is dated by is the report itself, and `device_state_at` is
-- already exactly that.

ALTER TABLE "mbos_devices"
  ADD COLUMN IF NOT EXISTS "tracker_watchdog_last_run_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mbos_devices"
  ADD COLUMN IF NOT EXISTS "tracker_restarts_today" integer;
