-- THE ODOMETER IS PHOTOGRAPHED AT BOTH ENDS, because one photograph cannot
-- show two readings.
--
-- `mbos_travel_legs` has carried `odometer_start_km` and `odometer_end_km`
-- since 0090 and exactly ONE `odometer_photo_id` beside them. That was right
-- for the screen it was built for: `/travel` is an after-the-fact day log, so
-- both readings are typed at the same moment from memory and a single
-- photograph of the meter as it stands is all there is to take.
--
-- It stops being right the moment the readings are taken when they actually
-- happen — one as he sets off, one when he arrives at the shop. Two numbers
-- half an hour apart cannot share a photograph, and the one that would be
-- missing is the departure: the reading nobody can go back and check, because
-- by then the meter has moved.
--
-- `odometer_photo_id` therefore KEEPS ITS MEANING and gains a name for it in
-- the code — it is the reading at the START. Nothing is renamed and nothing is
-- backfilled: every leg logged on `/travel` has one photograph covering a pair
-- of readings typed together, which is what it always meant, and inventing an
-- end photograph for it would be inventing evidence.
alter table "mbos_travel_legs"
  add column if not exists "odometer_end_photo_id" text;

do $$
begin
  alter table "mbos_travel_legs"
    add constraint "mbos_travel_legs_odometer_end_photo_id_attachments_id_fk"
    foreign key ("odometer_end_photo_id") references "attachments"("id");
exception when duplicate_object then null; end $$;

-- ONE LEG STILL RUNNING PER PERSON.
--
-- A leg opened from "Start visit" is the first here with a real gap between
-- its two ends: `ended_at` is null while he is on the road. A salesman cannot
-- be travelling to two shops at once, and two open legs would mean the arrival
-- photograph had a choice of which departure to close. The guard lives in the
-- database rather than in a service the next writer will not know about — the
-- same reasoning as the primary distributor's partial unique index.
--
-- It cannot catch the legs already there, and does not need to: `/travel`
-- writes `started_at` and `ended_at` in the same breath, so every existing row
-- is closed.
create unique index if not exists "mbos_travel_legs_one_open_per_user"
  on "mbos_travel_legs" ("user_id")
  where "ended_at" is null;

-- WHERE THE LEG CAME FROM, which decides what may be demanded of it.
--
-- Two kinds of leg now land in this table and they are different kinds of
-- evidence. A `day_log` leg is typed on `/travel` at the end of the day from
-- memory: both readings at once, a photograph if he happens to have taken one,
-- and no way to insist on more — the journey is over and refusing to record it
-- would only mean nobody finds out it happened.
--
-- A `visit` leg is opened when he presses Start visit and closed when he says
-- he has arrived, so the app is present at both ends and CAN insist: the meter
-- is photographed with the reading typed against it before the leg opens, and
-- again before the visit does. That is the whole point of asking at the moment
-- of travelling rather than afterwards, and it is only defensible because the
-- app was there.
--
-- The column is what lets the server hold the second to that standard without
-- holding the first to it. Defaulted to `day_log`, deliberately: every row
-- that exists was typed on `/travel` and keeps exactly the meaning it had, so
-- adding this moves no figure on any screen.
alter table "mbos_travel_legs"
  add column if not exists "origin" text not null default 'day_log';
