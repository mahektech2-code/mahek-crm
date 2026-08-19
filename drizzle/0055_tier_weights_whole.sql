-- The stored ranking had eight keys; the engine reads fourteen.
--
-- `getConfig` layers a stored value OVER the registry default rather than into
-- it, so a `queue.tierWeights` written before a reason kind existed leaves that
-- kind with no weight at all. Production was carrying exactly that: no
-- `paymentOverdue`, no `unreachable`, no `noAnswerRetry`, no `orderStatus`, and
-- `orderDueSoon` — a name the code renamed to `routineCall` and never migrated.
--
-- `undefined` does not throw in that arithmetic. It makes the entry's score
-- undefined, `b.score - a.score` NaN, and a comparator answering NaN orders
-- nothing — so calls about money, the highest tier there is, were ranked
-- arbitrarily, on a screen where nothing looked wrong.
--
-- The engine now falls back to the default for any missing key, so this
-- migration is not what makes the ranking correct. It is what makes the STORED
-- value describe the ranking, so the Settings screen shows the truth and the
-- next person to edit it is editing all of it.
--
-- Only where nobody has curated it: `updated_by_id is null`, the same test
-- 0042 and 0051 use. A team that chose its own ranking keeps it, and keeps the
-- fallback for anything their choice does not mention.
update app_settings
   set value = value
             || jsonb_build_object(
                  'paymentOverdue', 110,
                  'reminderOverdue', 100,
                  'reminderDueToday', 90,
                  'orderOverdueFullCycle', 80,
                  'orderDue', 70,
                  'routineCall', 60,
                  'prospect', 55,
                  'checkInOverdue', 50,
                  'orderLongOverdue', 45,
                  'checkInDue', 40,
                  'unreachable', 35,
                  'noAnswerRetry', 30,
                  'orderStatus', 10
                )
             - 'orderDueSoon'
 where key = 'queue.tierWeights'
   and updated_by_id is null;
