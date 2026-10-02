-- A PUNCH-IN AND A VISIT JOURNEY ARE OPEN AT THE SAME TIME, and the index
-- below refused that.
--
-- 0118 allowed one open leg per person, which was right when every leg was a
-- journey to one shop. 0127 added the punch-in SESSION leg, which stays open
-- from punch-in to punch-out, and every visit journey of the day opens and
-- closes inside it. With both under one rule, the handset had to close the
-- punch-in to start the first visit ("Set off for <shop> instead."): the
-- morning meter reading was closed at its own value, so the day's kilometres
-- measured nothing, and every later visit opened with no journey and a dwell
-- clock stuck at zero.
--
-- The rule is now one open JOURNEY per person, and separately one open SESSION
-- per person (mbos_travel_legs_open_session, from 0127, unchanged). He still
-- cannot be travelling to two shops at once.
DROP INDEX IF EXISTS mbos_travel_legs_one_open_per_user;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mbos_travel_legs_one_open_per_user
  ON mbos_travel_legs (user_id)
  WHERE ended_at IS NULL AND origin <> 'session';
