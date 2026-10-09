-- Which account an old-app (EMP 2.0) shop name is, as a person decided it.
--
-- The importer linked a typed shop name to any account whose name was merely
-- CLOSE (trigram similarity 0.6), and so put visits on the wrong customers'
-- timelines. It now links only an exact name carried by exactly one account,
-- and everything else waits for a person. This table is that person's answer,
-- keyed on the folded name, so one decision covers every row typed under it
-- and no sync overrides it. A null customer_id means "not on MahekOne".
--
-- The stored links are re-judged by `npm run jobs -- field-activity-rematch`
-- (and nightly), which also takes back the timeline entries the wrong ones
-- wrote.
CREATE TABLE IF NOT EXISTS field_activity_customer_decisions (
  name_key text PRIMARY KEY,
  shown_name text NOT NULL,
  customer_id text REFERENCES customers(id) ON DELETE CASCADE,
  decided_by_id text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);
