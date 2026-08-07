-- Clears the demo book: the invented customers and everything hanging off
-- them. Runs once, on the first deploy that carries it, and never again —
-- migrations are recorded, so merging this is the trigger and there is no
-- button for anybody to press twice.
--
-- Three kinds of row live in this database and only ONE of them goes.
--
--   The BOOK is invented and is what this removes: customers, orders, bills,
--   payments, calls, reminders, complaints, messages, targets, attendance and
--   the derived caches over them.
--
--   The TEAM and the CONFIGURATION stay. Delete the users and nobody can sign
--   in; delete app_settings and the queue has no thresholds to read.
--
--   The CATALOGUE stays. It is Mahek's real product master — written by the
--   seeder, which makes it look like demo data and it is not. No product
--   table is named below, so this cannot touch one even by accident.
--
-- The whole thing is wrapped in a guard. A migration that deletes rows must
-- refuse to run against a database that is not the one it was written for, and
-- "has products.raw_name" is the cheapest proof that this is our schema at the
-- right version. Anywhere else it does nothing and says so.

DO $$
DECLARE
  ours boolean;
  removed bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products'
       AND column_name = 'raw_name'
  ) INTO ours;

  IF NOT ours THEN
    RAISE NOTICE 'Not this schema - the demo book was left alone.';
    RETURN;
  END IF;

  -- Children first, so nothing is left pointing at a row that has gone.
  DELETE FROM queue_snapshots;
  DELETE FROM interaction_product_lines;
  DELETE FROM complaint_images;
  DELETE FROM complaint_status_history;
  DELETE FROM complaints;
  DELETE FROM follow_up_attempts;
  DELETE FROM follow_up_states;
  DELETE FROM inactive_watch_items;
  DELETE FROM wa_replies;
  DELETE FROM wa_messages;
  DELETE FROM wa_runs;
  DELETE FROM reminders;
  DELETE FROM payments;
  DELETE FROM bills;
  DELETE FROM orders;
  DELETE FROM calls;
  DELETE FROM monthly_targets;
  DELETE FROM eod_reports;
  DELETE FROM attendance;
  DELETE FROM notifications;
  DELETE FROM migration_exceptions;
  DELETE FROM attachment_bytes;
  DELETE FROM attachments;

  DELETE FROM customers;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'Demo book cleared - % customers and their history.', removed;
END $$;
