-- WHETHER THE BACKGROUND MACHINERY IS ACTUALLY RUNNING, which nothing asked.
--
-- Two mechanisms keep a handset reporting with the app closed: the location
-- task's own inline flush, and a WorkManager wake-up every fifteen minutes.
-- Both are registered in a try/catch that swallows the failure --
--
--   try { await BackgroundTask.registerTaskAsync(...) } catch { }
--
-- -- and nothing anywhere recorded whether either had ever RUN. So a handset
-- where registration threw on the first launch looked exactly like one syncing
-- perfectly, from the phone and from the office both. "It is enabled and
-- nothing reaches the database" is unanswerable in that state, because there
-- was never anything to look at.
--
-- NULLABLE, and staying that way, for the reason 0122 gives at length: an APK
-- cannot be recalled, every handset in the field will report none of this for
-- as long as it is out there, and null has to keep meaning "this build does not
-- say" rather than being read as no.
alter table "mbos_devices" add column if not exists "background_sync_registered" boolean;

-- WHEN IT LAST GENUINELY RAN, converted from a DURATION the handset sends
-- rather than an instant.
--
-- The rule 0122 states for `device_state_at` is the server's clock and never
-- the phone's, because a phone's clock is its owner's to set. That rule cannot
-- be followed literally here: "when did the background task last run" is a fact
-- only the handset holds. A duration is the way out -- it survives a clock that
-- is wrong by hours and is only exposed to drift across the interval itself --
-- so the wire carries seconds-ago and this column is stamped from them here.
alter table "mbos_devices" add column if not exists "background_sync_last_run_at" timestamptz;

-- WHEN THE WATCHDOG LAST CAUGHT THE TRACKER ACCEPTED AND SILENT.
--
-- The OS says yes to `startLocationUpdatesAsync` and then delivers nothing;
-- there is no second call to say so, and `background_location_granted` goes on
-- reading TRUE. Silence is the only evidence, the handset already reads it, and
-- until now it kept the verdict to itself and quietly fell back to the
-- foreground floor. A manager could see a trail with a hole in it and not that
-- the phone had been killed.
alter table "mbos_devices" add column if not exists "tracker_stalled_at" timestamptz;
