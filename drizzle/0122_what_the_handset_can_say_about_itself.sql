-- WHAT A HANDSET CAN SAY ABOUT ITSELF, and the one thing it can never say.
--
-- The Live map's team list could tell a manager where somebody was and
-- nothing whatever about the phone that was failing to tell him. A trail with
-- gaps in it has four ordinary causes -- the background permission refused,
-- location switched off on the device, no signal, or a flat battery -- and the
-- screen drew the same "No fix today" for all four. That sentence sends a
-- manager to ring a salesman and ask him to describe his own settings screen.
--
-- Every column here is NULLABLE and stays that way. An APK cannot be recalled,
-- so handsets already in the field will go on reporting none of this for as
-- long as they are out there, and null has to keep meaning "this build does
-- not say" rather than being mistaken for an answer.
--
-- WHAT IS DELIBERATELY ABSENT is a column claiming the internet is off. A
-- phone with no connection cannot report that it has no connection, so such a
-- column could only ever be written by a handset that was, at that moment,
-- online. Silence is what answers that question and it is derived from
-- `last_seen_at`, which the row already carries.
alter table "mbos_devices" add column if not exists "location_permission" text;
alter table "mbos_devices" add column if not exists "location_services_enabled" boolean;
alter table "mbos_devices" add column if not exists "connection_type" text;
alter table "mbos_devices" add column if not exists "battery_percent" integer;
alter table "mbos_devices" add column if not exists "battery_charging" boolean;
alter table "mbos_devices" add column if not exists "device_state_at" timestamp with time zone;

-- The readings are worth nothing without the moment they were taken, and a
-- battery figure with no timestamp beside it is the one that gets believed as
-- live. Refusing the combination in the database means no future writer can
-- introduce it by forgetting, on a path no test happens to cover.
alter table "mbos_devices" drop constraint if exists "mbos_devices_state_dated";
alter table "mbos_devices" add constraint "mbos_devices_state_dated" check (
  ("battery_percent" is null and "battery_charging" is null and "connection_type" is null)
  or "device_state_at" is not null
);

-- A percentage that is not a percentage is a screen printing "137%".
alter table "mbos_devices" drop constraint if exists "mbos_devices_battery_range";
alter table "mbos_devices" add constraint "mbos_devices_battery_range" check (
  "battery_percent" is null or ("battery_percent" >= 0 and "battery_percent" <= 100)
);

-- The OS's own four answers, and nothing else. `undetermined` is the OS saying
-- nobody has been asked yet, which is a different fact from this build not
-- reporting -- that one is null.
alter table "mbos_devices" drop constraint if exists "mbos_devices_location_permission";
alter table "mbos_devices" add constraint "mbos_devices_location_permission" check (
  "location_permission" is null
  or "location_permission" in ('always', 'while_using', 'denied', 'undetermined')
);

alter table "mbos_devices" drop constraint if exists "mbos_devices_connection_type";
alter table "mbos_devices" add constraint "mbos_devices_connection_type" check (
  "connection_type" is null
  or "connection_type" in ('wifi', 'cellular', 'none', 'unknown')
);

-- BACKFILL WHAT IS ALREADY KNOWN, and only what is already known.
--
-- `background_location_granted` = true can only have been written by a handset
-- that started background tracking, which is the OS's `always`. False cannot be
-- read the same way: it is exactly the ambiguity this migration exists to end,
-- covering both "while using the app" and "refused", so it is left null for the
-- handset to answer properly on its next report. Guessing `while_using` here
-- would put a fact on the screen that nobody established.
update "mbos_devices"
   set "location_permission" = 'always'
 where "background_location_granted" is true
   and "location_permission" is null;
