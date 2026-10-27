-- THE INCLUSIVE PRICE IS KEPT TO THE PAISA.
--
-- `price_list_rates.rate_incl_gst_paise` was written rounded to the rupee by
-- `inclFromEx`, so a rate of ₹1,933 ex-GST was stored, and shown on every
-- price screen, as ₹2,281 inclusive when it is ₹2,280.94. The function now
-- keeps the paise; this rewrites the rows the old rule wrote.
--
-- Only those rows. A row is touched when its stored figure is exactly what the
-- old rule gave (the rupee nearest ex-GST times 1 + GST) AND that rupee is not
-- itself a printed price — a whole rupee that converts back to exactly the
-- stored ex-GST rate, which is how a figure read off a printed list is stored
-- and must keep reading as printed. An inclusive price somebody typed with
-- paise is not a whole rupee, so the first test already leaves it alone.
--
-- The sum is the one `price-math.ts` does — ex × (10,000 + GST bp) ÷ 10,000,
-- rounded half up — in numeric arithmetic, so a later save of the same rate
-- writes the same paise this does.
WITH calc AS (
  SELECT r.id,
         r.rate_ex_gst_paise AS ex,
         r.rate_incl_gst_paise AS incl,
         l.gst_bp AS gst,
         round(r.rate_ex_gst_paise::numeric * (10000 + l.gst_bp) / 10000) AS exact
    FROM price_list_rates r
    JOIN price_lists l ON l.id = r.price_list_id
   WHERE r.rate_ex_gst_paise > 0
), judged AS (
  SELECT id, ex, incl, gst, exact, round(exact / 100) * 100 AS rupee
    FROM calc
)
UPDATE price_list_rates p
   SET rate_incl_gst_paise = j.exact
  FROM judged j
 WHERE p.id = j.id
   AND j.incl = j.rupee
   AND j.exact <> j.rupee
   AND round(j.rupee * 10000 / (10000 + j.gst)) <> j.ex;
