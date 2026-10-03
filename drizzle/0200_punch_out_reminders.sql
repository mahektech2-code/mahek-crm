-- HOW MANY PUNCH-OUT REMINDERS THIS DAY HAS BEEN SENT. The server sends one at
-- `mbos.attendance.punchOutPromptHour` and a second after
-- `mbos.attendance.punchOutSecondReminderMinutes` to anybody still punched in,
-- from a pass that runs every half hour — so it has to know what it already
-- sent, or every pass after six would send it again. The count lives on the
-- DAY rather than in the notification row because "this day has been reminded
-- twice" is a fact about the day, and the notification table has no source
-- key to ask. Zero is every day that exists today, which is correct: none of
-- them was reminded by the server.
ALTER TABLE mbos_attendance_days
  ADD COLUMN IF NOT EXISTS punch_out_reminders smallint NOT NULL DEFAULT 0;
