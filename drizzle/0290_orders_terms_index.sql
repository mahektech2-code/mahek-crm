-- A BILL'S CREDIT TERM, FOUND WITHOUT READING THE CUSTOMER'S WHOLE HISTORY.
--
-- billCreditDaysSql (lib/bill-terms.ts) asks, for every bill, for the newest
-- order of that customer carrying a credit term and placed on or before the
-- bill's date. It is read over every bill in the book by the collections
-- worklist, outstanding, the slow-payer flag, the WhatsApp reminders and the
-- accounts home — and with no index on the question it read all of a
-- customer's orders per bill. Newest first, only the orders that state a term.
CREATE INDEX IF NOT EXISTS "orders_customer_terms_idx" ON "orders" USING btree ("customer_id", "ordered_at" DESC) INCLUDE ("credit_days") WHERE "credit_days" IS NOT NULL;
