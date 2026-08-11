-- Field orders stop calling themselves telecaller orders.
--
-- THE SEQUENCING, which is the whole reason this is its own file:
--
--   0037  adds 'mbos' to the `order_source` enum, and uses it nowhere.
--   0038  backfills `orders.order_no`, using nothing new.
--   0039  is this — the first statement anywhere that USES the value.
--
-- Postgres refuses to let a value added to an enum be used in the transaction
-- that added it (55P04), and drizzle-kit applies every pending migration in
-- ONE transaction. So on a database that is already live, 0037 committed in an
-- earlier run and this is safe; on a FRESH database all three apply together
-- and this would throw — even matching zero rows, because the literal is
-- resolved before any row is examined.
--
-- What makes both paths work is that the rows this fixes cannot exist on a
-- fresh database. It is guarded by an EXISTS that mentions only values that
-- already existed, and the literal `'mbos'` appears only inside a string that
-- is EXECUTEd — so on a fresh install the branch is not taken, nothing is
-- parsed, and nothing throws. Where the branch IS taken, 0037 is committed by
-- definition: there is no other way for a row carrying a series order number
-- to be sitting there.
--
-- Re-running matches nothing, because the rows it fixed are no longer `crm`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "orders"
     WHERE "source" = 'crm'
       AND "order_no" ~ '^[A-Za-z0-9]+/[0-9]{2}-[0-9]{2}/[0-9]+$'
  ) THEN
    EXECUTE $q$
      UPDATE "orders"
         SET "source" = 'mbos',
             "updated_at" = now()
       WHERE "source" = 'crm'
         AND "order_no" ~ '^[A-Za-z0-9]+/[0-9]{2}-[0-9]{2}/[0-9]+$'
    $q$;
  END IF;
END $$;
