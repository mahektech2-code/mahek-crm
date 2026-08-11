-- Vikram holds the admin ROLE, not merely the Admin app.
--
-- The two were different things and the difference was invisible: he opens
-- every screen in the product, including the console, and `can()` still
-- refused him `customer.reassign`, `order.approve`, `payment.confirm` and
-- `creditnote.issue` — because those read the role and his was `manager`.
-- Update account manager sat disabled under a tooltip saying it was "an
-- accounts or admin action", to the person who runs the Admin app, on a
-- deployment where NO account held the admin role at all. That branch of
-- `can()` was unreachable in practice.
--
-- This is a decision about one person and it is written here rather than left
-- to `db:seed`, because seeding wipes the database and production is not
-- reseeded. `scripts/set-role.ts` is the way to do the next one.
--
-- Guarded on the current role so it is idempotent and so it cannot quietly
-- promote a rebuilt account that somebody has since made something else.
UPDATE "users"
   SET "role" = 'admin'
 WHERE "email" = 'vikram@mahek.in'
   AND "role" = 'manager';
