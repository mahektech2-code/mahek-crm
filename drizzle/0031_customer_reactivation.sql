-- Bringing a customer back is a decision too, so it is asked for the same way.
--
-- Deactivation already worked in two halves: a telecaller who knows the
-- account raises it with a reason, and a manager decides. Coming back had no
-- half at all — `recomputeInactivity` says so in a comment where it refuses to
-- reverse a deactivation on the strength of an order: "A telecaller who wants
-- them back asks for that separately." There was nowhere to ask.
--
-- These mirror `deactivation_requested` and `deactivation_reason` exactly,
-- rather than being folded into them. One pair of columns carrying a request
-- in whichever direction the status happens to imply is a pair nobody can
-- read six months later, and a customer can legitimately have neither.
ALTER TABLE "customers" ADD COLUMN "reactivation_requested" boolean DEFAULT false NOT NULL;
ALTER TABLE "customers" ADD COLUMN "reactivation_reason" text;
