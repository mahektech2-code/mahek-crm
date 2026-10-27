-- THE INCLUSIVE PRICE IS KEPT TO THE PAISA.
--
-- `price_list_rates.rate_incl_gst_paise` was written rounded to the rupee by
-- `inclFromEx`, so a rate of ₹1,933 ex-GST was stored, and shown on every
-- price screen, as ₹2,281 inclusive when it is ₹2,280.94. The function now
-- keeps the paise; this rewrites the rows the old rule wrote.
--
-- Only those rows, and only where the paise are real. A row is touched when
-- its stored figure is exactly what the old rule gave (the rupee nearest
-- ex-GST times 1 + GST) AND the exact figure is more than one paisa from that
-- rupee. Within a paisa is the precision of storing ex-GST — a printed ₹2,281
-- comes back as ₹2,280.99 or ₹2,281.00, and Odisha Paid's ₹12 a litre makes
-- ₹2,521.01 — and `inclFromEx` reads those as the rupee, so they stay. An
-- inclusive price somebody typed with paise is not a whole rupee, so the first
-- test already leaves it alone.
--
-- A DERIVED list (one with a `derivation`, generated from its parent by a
-- rule) is skipped entirely: it exists to be printed, the office prints it in
-- whole rupees, and `listInclFromEx` keeps showing it that way — its rule can
-- only be stored to the paisa ex-GST, so its exact figure would be a few paise
-- of noise on a big pack.
--
-- The sum is the one `price-math.ts` does — ex × (10,000 + GST bp) ÷ 10,000,
-- rounded half up — in numeric arithmetic, so a later save of the same rate
-- writes the same paise this does.
WITH calc AS (
  SELECT r.id,
         r.rate_incl_gst_paise AS incl,
         round(r.rate_ex_gst_paise::numeric * (10000 + l.gst_bp) / 10000) AS exact
    FROM price_list_rates r
    JOIN price_lists l ON l.id = r.price_list_id
   WHERE r.rate_ex_gst_paise > 0
     AND l.derivation IS NULL
), judged AS (
  SELECT id, incl, exact, round(exact / 100) * 100 AS rupee
    FROM calc
)
UPDATE price_list_rates p
   SET rate_incl_gst_paise = j.exact
  FROM judged j
 WHERE p.id = j.id
   AND j.incl = j.rupee
   AND abs(j.exact - j.rupee) > 1;
