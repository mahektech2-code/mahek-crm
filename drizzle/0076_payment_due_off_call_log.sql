-- A payment call is collections' own worklist, not a reason to ring for an
-- order. Folding it into the Call Log put a telecaller's screen in front of a
-- debt they cannot act on and cannot record an outcome against — that
-- worklist lives at /crm/payments, where accounts already work it.
--
-- A default in the registry is not enough on its own. `seedConfig` writes a
-- row for every setting the first time it runs, so a deployment that has been
-- seeded carries a stored `true` that would win over the new `false` default
-- for ever.
--
-- `updated_by_id` is null on a row `seedConfig` wrote and carries an actor id
-- on anything saved from the Settings screen, so this matches a stored value
-- nobody has touched AND the value still being the previous default. A team
-- that deliberately turned this on is left alone.
UPDATE "app_settings"
   SET "value" = 'false'::jsonb
 WHERE "key" = 'queue.includePaymentDue'
   AND "updated_by_id" IS NULL
   AND "value" = 'true'::jsonb;
