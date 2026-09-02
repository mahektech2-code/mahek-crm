-- Every stated overdue bill, not only the oldest one, plus a full "OUTSTANDING
-- OF <customer>" statement, a pre-due nudge, a broken-promise follow-up and a
-- payment-received thank-you.
--
-- The outstanding statement did not exist as a template at all — this team
-- was composing it by hand outside the app, one customer at a time, from the
-- ledger — so it is inserted rather than matched against anything. Stage 2 and
-- 3 named only the OLDEST bill via {{bill_no}}/{{bill_due}}, so an account
-- with three overdue bills read a reminder about one of them; both are
-- extended to the full {{bills_list}} the new "Outstanding statement"
-- template also uses.
--
-- Guarded the way `0076` guards a setting: a template body is touched only
-- where nobody has ever customised it (`updated_by_id is null`) and it still
-- reads exactly as this project shipped it — a team that already edited its
-- own wording is left alone, and re-running this migration changes nothing a
-- second time.
--
-- Two "old body" spellings, not one: every template actually seeded so far
-- signs off with an em dash (— {{owner}}), which is what `seed.ts` wrote
-- at the time these rows were created, though the file has since moved to a
-- plain hyphen. Matching only the current source would leave every deployment
-- seeded before that change — this one included — with a body that never
-- matches, and the whole update silently doing nothing.
UPDATE "wa_templates"
   SET "body" = E'Namaste {{contact}} ji,\n\n{{outstanding}} is now overdue against {{customer}}.\n\n{{bills_list}}\n\nPlease confirm a date by which we can expect the payment.\n\n- {{owner}}, Mahek Marketing India',
       "updated_at" = now()
 WHERE "name" = 'Payment reminder · stage 2'
   AND "updated_by_id" IS NULL
   AND "body" IN (
     E'Namaste {{contact}} ji,\n\n{{outstanding}} is now overdue against {{customer}}.\n\nBill {{bill_no}} was due on {{bill_due}}. Please confirm a date by which we can expect the payment.\n\n- {{owner}}, Mahek Marketing India',
     E'Namaste {{contact}} ji,\n\n{{outstanding}} is now overdue against {{customer}}.\n\nBill {{bill_no}} was due on {{bill_due}}. Please confirm a date by which we can expect the payment.\n\n— {{owner}}, Mahek Marketing India'
   );

UPDATE "wa_templates"
   SET "body" = E'Namaste {{contact}} ji,\n\nDespite earlier reminders, {{outstanding}} remains unpaid against {{customer}}.\n\n{{bills_list}}\n\nWe would like to settle this before further supplies. Please call us today.\n\n- {{owner}}, Mahek Marketing India',
       "updated_at" = now()
 WHERE "name" = 'Payment reminder · stage 3'
   AND "updated_by_id" IS NULL
   AND "body" IN (
     E'Namaste {{contact}} ji,\n\nDespite earlier reminders, {{outstanding}} remains unpaid against {{customer}}.\n\nWe would like to settle this before further supplies. Please call us today.\n\n- {{owner}}, Mahek Marketing India',
     E'Namaste {{contact}} ji,\n\nDespite earlier reminders, {{outstanding}} remains unpaid against {{customer}}.\n\nWe would like to settle this before further supplies. Please call us today.\n\n— {{owner}}, Mahek Marketing India'
   );

-- New templates for the rest of the payment lifecycle. Inserted only where a
-- deployment does not already carry one of this exact name, so re-running
-- this migration — or a team that independently built its own "Outstanding
-- statement" — never creates a duplicate.
INSERT INTO "wa_templates" ("id", "name", "category", "escalation_stage", "body", "applies_to")
SELECT
  'tpl_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  v.name, v.category::template_category, v.escalation_stage, v.body, v.applies_to::dest_kind
FROM (VALUES
  (
    'Outstanding statement',
    'payment_reminder',
    NULL::integer,
    E'*OUTSTANDING OF {{customer}}*\nAs on {{as_of}}\n\nDear Sir/Madam,\n\nYour following bills are due for payment. We request you to take immediate steps for settling the overdue bills and oblige.\n\n{{bills_list}}\n\nTotal Amount {{outstanding}} is overdue for payment.\n\nPlease ignore if already paid.\n\nWith regards\nCustomer Relationship Manager\nFor Mahek Marketing India,\n{{owner}}',
    'personal'
  ),
  (
    'Pre-due reminder',
    'payment_reminder',
    NULL::integer,
    E'Namaste {{contact}} ji,\n\nThis is a reminder that bill {{bill_no}} for {{customer}} is due on {{bill_due}}.\n\nKindly plan the payment so it reaches us on time.\n\n- {{owner}}, Mahek Marketing India',
    'personal'
  ),
  (
    'Broken promise follow-up',
    'payment_reminder',
    NULL::integer,
    E'Namaste {{contact}} ji,\n\nYou had told us {{promised_amount}} would reach us by {{promised_date}} against {{customer}}, and we have not yet received it.\n\nKindly let us know a revised date, or arrange the payment today.\n\n- {{owner}}, Mahek Marketing India',
    'personal'
  ),
  (
    'Payment received - thank you',
    'other',
    NULL::integer,
    E'Namaste {{contact}} ji,\n\nThank you - we have received your payment towards {{customer}}''s account.\n\nBalance outstanding, if any: {{outstanding}}.\n\n- {{owner}}, Mahek Marketing India',
    'personal'
  )
) AS v(name, category, escalation_stage, body, applies_to)
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" t WHERE t.name = v.name);
