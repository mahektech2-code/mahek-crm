-- THE AUDIT LOG WAS BEING READ END TO END ON EVERY CALL LOG OPEN.
--
-- `audit_log` carries no index on `action`, and two hot paths filter on it:
--
--   * the queue's skip lookup — `action = 'queue.skip'` — which runs inside
--     `queueInputs`, so it happens on every load of the CRM dashboard AND of
--     the Call Log. Measured on prod: a sequential scan of 11,877 rows, 645
--     buffer pages, to find the 23 rows that are skips. Twice per navigation.
--
--   * the Accounts audit screen, `action in (…) order by at desc limit 500`:
--     another full scan, 11,557 rows discarded to keep 320.
--
-- Neither is slow in isolation — 5.5 ms each — and that is the point. On a
-- droplet with one shared vCPU the cost that matters is not the millisecond,
-- it is 645 pages of buffer churn per page load competing for 128 MB of
-- shared_buffers with everything else the screen needs.

/* --------------------------------------------- the queue's skip lookup */

-- PARTIAL, because 23 rows of 11,877 are skips. A partial index is a few
-- kilobytes that answers the question exactly, and it costs the write path
-- nothing on the 99.8% of audit rows that are not skips — which matters, since
-- `audit_log` is written by every audited action in the product.
--
-- `at desc` is in the index because the query is `distinct on (entity_id) …
-- order by entity_id, at desc`: the sort is part of the question.
CREATE INDEX IF NOT EXISTS audit_log_queue_skip_idx
  ON audit_log (entity_id, at DESC)
  WHERE action = 'queue.skip';
--> statement-breakpoint

/* ------------------------------------------------ every other action */

-- NOT partial, and not only for the audit screen. `action` is how anybody asks
-- this table anything — "what moved when Suresh left", "who approved this" —
-- and those questions are asked from a console by a person waiting. `at desc`
-- trails it so the ordinary shape, one action's history newest first, is
-- answered from the index without a sort.
CREATE INDEX IF NOT EXISTS audit_log_action_at_idx ON audit_log (action, at DESC);
--> statement-breakpoint

/* ------------------------------------------------------ the bill ledger */

-- `listBills` ends `order by bill_date desc` and there is no index on it, so
-- every bills screen sorts 10,815 rows to show 25. The financial-year filter
-- narrows the set but not the sort, because it matches on `bill_no` text.
CREATE INDEX IF NOT EXISTS bills_bill_date_idx ON bills (bill_date DESC);
