-- A DAY THAT OPENED ON A CLAIM, and how the office tells it from one that
-- opened clean.
--
-- The handset now refuses to open a day until it can show it will record the
-- trail: a salesman on a vivo checked in at 04:16, posted not one position all
-- day, and every permission on his phone read correct — the OEM battery
-- manager had killed the tracking service the OS had genuinely started. That
-- gate is the fix, and a gate that stops a man working is a support call. A
-- support call the office cannot answer is worse than the fault it came from,
-- so what the phone said about itself as the day opened is stored beside the
-- day.
--
-- THREE FACTS AND THREE COLUMNS, because two of them collapse into a lie.
-- `setup_ready` is what the handset could actually CHECK. `setup_acknowledged_at`
-- is the man saying he did the steps nothing can check — the autostart and
-- battery screens no Android API reports — which is a CLAIM and is never to be
-- rendered as a proof. `setup_unverified` is what he was still being asked for
-- when he said it. Without the first, a day opened under a lowered gate would
-- arrive here looking exactly like a day with nothing wrong with it, which is
-- the loss the attendance selfie's "Start the day without a photo" button
-- produced and the reason that button was removed.
--
-- EVERY COLUMN IS NULLABLE AND STAYS THAT WAY, like `mbos_devices`' own device
-- state one migration back. An APK cannot be recalled, so handsets in the
-- field will report none of this until they are updated, and null has to keep
-- meaning "this build does not say" rather than being read as an answer.
alter table "mbos_attendance_days" add column if not exists "setup_ready" boolean;
alter table "mbos_attendance_days" add column if not exists "setup_acknowledged_at" timestamp with time zone;
alter table "mbos_attendance_days" add column if not exists "setup_unverified" jsonb;

-- A list, or nothing. `jsonb` will take a bare string or a number perfectly
-- happily, and a column that can hold either is one every reader has to defend
-- itself against.
alter table "mbos_attendance_days" drop constraint if exists "mbos_attendance_days_setup_unverified_array";
alter table "mbos_attendance_days" add constraint "mbos_attendance_days_setup_unverified_array" check (
  "setup_unverified" is null or jsonb_typeof("setup_unverified") = 'array'
);

-- WHAT IS DELIBERATELY NOT CONSTRAINED is the pair. An acknowledgement can
-- only arise where something was unverified, so "acknowledged and ready" looks
-- like a state that should be refused — and refusing it would mean refusing a
-- check-in, which is the one write in this product that must never be lost to
-- a rule about its own metadata. A handset that claimed and then fixed the
-- setting before pressing the button is an honest race, not a fault.

-- AND WHAT IS DELIBERATELY NOT A COUNTER: how many days in a row a man has
-- opened on a claim. That is the question the office actually asks — he has
-- pressed the button twice and is still not being recorded — and it is
-- answered by reading these rows against `mbos_positions`, which is where the
-- only real evidence is. A counter would be a cache with nothing rebuilding
-- it, derived from the two columns it was caching.
