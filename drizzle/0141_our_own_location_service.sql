-- OUR OWN RECORDER, AND THE FOUR FACTS THAT SAY WHY A PHONE WENT QUIET.
--
-- The trail has run on `expo-location`'s background task since it shipped, and
-- in production it stops. Measured on this book: fifty-one separate silences
-- inside one working day losing 523 minutes between them; another day of
-- sixty-one silences and 514 minutes; single gaps of 999, 498, 456 and 437
-- minutes. Every live handset self-reports `tracker_stalled_at`. A vivo V2333
-- on the current build, with `location_permission = 'always'`, background
-- granted and location services on, stalled five minutes after check-in.
--
-- The cause is one line in a library we do not own:
-- `LocationTaskConsumer.maybeStartForegroundService()` returns early on
-- `if (!AppForegroundedSingleton.isForegrounded)`, and that singleton is set
-- only from `OnActivityEntersForeground`. A task restored into a headless
-- process has no Activity, so no foreground service is started, and from
-- Android 10 the OS throttles a background app's location to a few fixes an
-- hour. Only a person opening the app puts the dense tracker back — which is
-- exactly the silence-then-burst shape in the data.
--
-- So MBOS now runs a foreground service of its own, startable from a broadcast
-- receiver and from a WorkManager worker with no Activity anywhere. These
-- columns are what it reports, on the position batch that is already open.
--
-- EVERY ONE IS NULLABLE AND EVERY ONE DEFAULTS TO NULL, deliberately. An APK
-- cannot be recalled: a handset in somebody's pocket runs the build it has
-- until a person installs the next one, and for all of those `null` means
-- "this build has no such service" rather than "the service is not running".
-- `lib/mbos/device-state.ts` omits a field it was not told about, so an older
-- handset's report cannot wipe a newer one's answers for the same phone.
alter table "mbos_devices" add column if not exists "location_service_running" boolean;
--> statement-breakpoint

-- WHEN IT LAST TOOK A FIX, which is the only evidence `running` means
-- anything. A service can hold its notification, keep its process alive, and
-- have a fused provider that has quietly stopped delivering — Play services
-- updated under a running app, a ROM suspending the provider without touching
-- the process. That failure is invisible in every other column on this row.
--
-- Stamped from a DURATION the handset sends rather than an instant it claims,
-- like `background_sync_last_run_at` and `tracker_stalled_at` beside it: when
-- the service last took a fix is a fact only the phone holds, and seconds-ago
-- survives a clock wrong by hours where an absolute instant would not.
alter table "mbos_devices" add column if not exists "location_service_last_fix_at" timestamp with time zone;
--> statement-breakpoint

-- FIXES THE RECORDER IS STILL HOLDING, not yet in the upload queue.
--
-- The service writes to its own store on the phone, because it runs with the
-- app shut and cannot reach the database the JavaScript bundle opens. The app
-- moves those rows across the next time it is alive. A figure here that is not
-- draining is a phone whose JavaScript has not run for hours, which is a
-- different fault from a phone with no signal — and until this column the two
-- were the same silence.
alter table "mbos_devices" add column if not exists "location_service_buffered" integer;
--> statement-breakpoint

-- HOW MANY TIMES TODAY THE RECORDER HAD TO BE STARTED.
--
-- The single most useful number on this row. One start is the check-in;
-- twenty is a battery manager killing the tracker twenty times, which no
-- Android API reports and which every other column can only describe the
-- effects of. Counted on the handset's own local calendar day and rolled over
-- at its midnight: overnight is when a phone is charged and when an OEM's own
-- bookkeeping resets, so yesterday's twenty say nothing about this morning.
alter table "mbos_devices" add column if not exists "location_service_starts_today" integer;
--> statement-breakpoint

-- WHEN THE PLATFORM ITSELF REFUSED TO START IT, which is a completely
-- different support call.
--
-- Android 12 forbids starting a foreground service from the background outside
-- a short list of exempt moments. A phone that has not been given the battery
-- exemption is refused there BY DESIGN — nothing is being killed, and the fix
-- is one tap on the handset's own Sync screen rather than a trip through an
-- OEM settings tree. Conflated with `tracker_stalled_at` it would send
-- somebody to ask for a switch that is already on, and the salesman — who can
-- see it is on — stops believing the next thing the office tells him.
alter table "mbos_devices" add column if not exists "location_service_refused_at" timestamp with time zone;
--> statement-breakpoint

-- The platform's own word for the refusal, kept as text rather than mapped to
-- a list here. A refusal nobody has seen before arrives as itself rather than
-- as a category somebody guessed, which is the same reason `sync_conflicts`
-- stores what the sheet actually said.
alter table "mbos_devices" add column if not exists "location_service_refusal" text;
