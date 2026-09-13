-- How he is travelling TODAY, asked once at the punch-in.
--
-- The mode was a per-stop question and stayed one all day: a man on his own
-- bike answered "own bike" eleven times and photographed the meter twenty-two
-- times to record one ride he never got off. The vehicle is a fact about the
-- SESSION — he punches in on it and punches out on it — and only public
-- transport genuinely changes leg to leg, which is why that one alone goes on
-- asking.
--
-- Nothing here is an enum, for the reason `mbos_travel_modes` was a table in
-- the first place: an admin changes this list without a developer.

/* ------------------------------------------------- where a mode is offered */

-- `day` | `leg` | `both`.
--
-- DEFAULT 'leg' is the load-bearing half: every row that existed keeps being
-- offered exactly where it was offered, so applying this migration alone
-- changes no screen. The UPDATEs below are what move them.
ALTER TABLE mbos_travel_modes ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'leg';
--> statement-breakpoint

-- A vehicle he is on all day is answered at the punch-in and never again.
UPDATE mbos_travel_modes SET scope = 'day'
 WHERE key IN ('own_bike', 'own_car', 'company_vehicle', 'customer_vehicle');
--> statement-breakpoint

-- Walking is BOTH, and it is the only one that is.
--
-- It is a way to spend a day and it is also a way to get from one shop to the
-- next on a day spent on buses — two shops on the same street is a walk, and
-- making him name a vehicle he did not take would put a fare on a leg that
-- cost nothing.
UPDATE mbos_travel_modes SET scope = 'both' WHERE key = 'walking';
--> statement-breakpoint

-- The umbrella, and the only day-level answer that leaves a question open.
--
-- `actuals` because that is what its children are; no odometer and no ticket
-- of its own, since neither is claimed against the umbrella — the bus, the
-- train, the auto and the taxi underneath it carry the fares.
INSERT INTO mbos_travel_modes (id, key, label, sort_order, reimbursement_kind, requires_odometer, requires_ticket, scope)
VALUES ('xmode_public_transport', 'public_transport', 'Public transport', 25, 'actuals', false, false, 'day')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

/* ----------------------------------------------- the session as a journey */

-- `day_log` | `visit` | `session`, and the third is new.
--
-- A session leg runs from the punch-in to the punch-out and carries the two
-- meter readings that used to be taken eleven times a day. It is a LEG rather
-- than a pair of columns on the attendance row so that the policy engine
-- prices it with everything else: one table, one per-km rule, one figure for
-- the day. `origin` already decides what may be demanded of a leg, and this
-- one is the strictest — the app is present at both ends, so both readings and
-- both photographs are required.
--
-- No schema change is needed for the value itself; `origin` is text with a
-- default. This comment is the whole of the change, and it is worth having.

/* ------------------------------------------ a leg that is not its own claim */

-- Movement, recorded, and NOT a second claim for the same kilometres.
--
-- On an own-vehicle session the money comes from the session's meter pair. The
-- visits still open legs — the arrival gate, the navigation and the record of
-- where he actually went all hang off one — and pricing those as well would
-- pay per-km twice over the same ride, once on the meter and once on the GPS
-- trail. So they are marked, with the reason ON the row: a leg excluded from a
-- claim by a rule nobody can read from the record is how an expense argument
-- becomes unanswerable.
--
-- DEFAULT false, so every leg already written stays exactly as claimable as it
-- was.
ALTER TABLE mbos_travel_legs ADD COLUMN IF NOT EXISTS claim_excluded boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE mbos_travel_legs ADD COLUMN IF NOT EXISTS claim_excluded_reason text;
--> statement-breakpoint

-- One open session leg per person, exactly as there is one open visit leg.
-- He cannot be punched in on two vehicles at once, and two open session legs
-- would leave the punch-out photograph with a choice of which punch-in to
-- close.
CREATE UNIQUE INDEX IF NOT EXISTS mbos_travel_legs_open_session
  ON mbos_travel_legs (user_id)
  WHERE origin = 'session' AND ended_at IS NULL;
