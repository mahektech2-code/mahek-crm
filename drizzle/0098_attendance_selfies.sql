-- Attendance is photographed at BOTH ends, every time, all day.
--
-- Three columns, and the middle one is the substantial change.
--
-- `check_out_selfie_id` is the counterpart `check_in_selfie_id` never had.
-- The handset has taken a check-in selfie since it shipped and took none at
-- the check-out, so a day proved that somebody arrived and proved nothing
-- whatever about when they stopped — which is the half that decides the hours.
-- Both are mandatory now: there is no path through the handset's attendance
-- module that writes a session end without one, and the camera screen's only
-- ways out are the photograph and abandoning the action.
--
-- `sessions` is the day as the handset has always modelled it and the server
-- never held: `[{ inAt, outAt, inSelfieId, outSelfieId }]`, oldest first, at
-- most one open. A salesman breaks for lunch or comes out again in the
-- evening, so a day is several stretches of work — and this table kept one
-- pair of timestamps, which meant 9-to-1 plus 2-to-6 arrived as nine hours on
-- the record that feeds a payslip, with the break invisible to the office.
-- It is ALSO the only place N selfies can live: a day with two breaks carries
-- six photographs, and two columns cannot hold six ids. The two selfie
-- columns are the first-in and last-out mirrors of the list, exactly as
-- `check_in_at` and `check_out_at` already are.
--
-- Defaulting to `[]` is what makes this safe on a database with history in it:
-- every existing row keeps precisely the meaning it had, and nothing reads the
-- list until a handset sends one. The days already recorded are NOT
-- backfilled from their two marks — a single pair inferred into a session
-- list would be a guess presented as a report, and on a day that really had a
-- break it would be the wrong guess.

alter table "mbos_attendance_days"
  add column if not exists "check_out_selfie_id" text;

alter table "mbos_attendance_days"
  add column if not exists "sessions" jsonb not null default '[]'::jsonb;

do $$
begin
  alter table "mbos_attendance_days"
    add constraint "mbos_attendance_days_check_out_selfie_id_attachments_id_fk"
    foreign key ("check_out_selfie_id") references "attachments"("id")
    on delete no action on update no action;
exception
  when duplicate_object then null;
end $$;
