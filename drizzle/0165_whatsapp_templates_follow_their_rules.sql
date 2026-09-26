-- The eight WhatsApp templates approved in Wati, as CRM templates.
--
-- wa_templates.wati_spec names the rule set in lib/wati-templates.ts that fills
-- a template's variables and refuses it when any would be untrue. A template
-- with a spec is rendered by those rules on EVERY route — preview, manual copy
-- and API send — so the three cannot say different things to a customer.
--
-- The bodies are the Wati wording verbatim. They are inserted UNLINKED
-- (wati_template_name null): which approved Wati template a CRM template is
-- sent as is the founder's decision, made on the Founder Dashboard. No
-- escalation stage either — which reminder goes at which stage is Mahek's
-- timeline, not something to guess in a migration.
ALTER TABLE "wa_templates" ADD COLUMN IF NOT EXISTS "wati_spec" text;
--> statement-breakpoint
INSERT INTO "wa_templates" ("id", "name", "category", "body", "applies_to", "active", "wati_spec")
SELECT 'tpl_wati_payment_followup_1', 'Payment follow-up', 'payment_reminder', $b$*PAYMENT FOLLOW-UP – {{customer_name}}*

Dear Sir/Madam,

This is a gentle reminder that the following bills are overdue as on {{as_of_date}}:

{{bills_list}}

*Total Overdue: ₹{{total_overdue}}*

Kindly arrange the payment and let us know the expected payment date so we can update our records.

Please tap an option below. If already paid, kindly share the payment reference (UTR / cheque no.) in reply.

Regards,
*Accounts Department*
*Mahek Marketing India*$b$, 'personal', true, 'payment_followup_1'
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" WHERE "id" = 'tpl_wati_payment_followup_1');
--> statement-breakpoint
INSERT INTO "wa_templates" ("id", "name", "category", "body", "applies_to", "active", "wati_spec")
SELECT 'tpl_wati_payment_statement', 'Outstanding statement', 'payment_reminder', $b$*OUTSTANDING STATEMENT – {{customer_name}}*
As on {{as_of_date}}

Dear Sir/Madam,

The following bills are due for payment:

{{bills_list}}

*Total Due: ₹{{total_due}}*

We request you to arrange the payment of the overdue bills at the earliest.

Please tap an option below, or ignore this message if already paid.

Regards,
*Accounts Department*
*Mahek Marketing India*$b$, 'personal', true, 'payment_statement'
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" WHERE "id" = 'tpl_wati_payment_statement');
--> statement-breakpoint
INSERT INTO "wa_templates" ("id", "name", "category", "body", "applies_to", "active", "wati_spec")
SELECT 'tpl_wati_payment_followup_urgent', 'Urgent payment follow-up', 'payment_reminder', $b$*URGENT PAYMENT FOLLOW-UP – {{customer_name}}*

Dear Sir/Madam,

The following bills are still outstanding:

{{bills_list}}

*Total Overdue: ₹{{total_overdue}}*
*Oldest bill overdue by: {{oldest_overdue_days}} days*

We request you to arrange the payment at the earliest and confirm the expected payment date.

If there is any issue regarding the payment, please let us know so we can resolve it together. Please tap an option below; if already paid, kindly share the payment reference in reply.

Regards,
*Accounts Department*
*Mahek Marketing India*$b$, 'personal', true, 'payment_followup_urgent'
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" WHERE "id" = 'tpl_wati_payment_followup_urgent');
--> statement-breakpoint
INSERT INTO "wa_templates" ("id", "name", "category", "body", "applies_to", "active", "wati_spec")
SELECT 'tpl_wati_payment_credit_hold', 'Overdue payment – credit hold', 'payment_reminder', $b$*IMPORTANT – OVERDUE PAYMENT – {{customer_name}}*

Dear Sir/Madam,

Despite our earlier reminders, the following bills remain outstanding:

{{bills_list}}

*Total Overdue: ₹{{total_overdue}}*
*Oldest bill overdue by: {{oldest_overdue_days}} days*

We request you to arrange the payment immediately and confirm the payment status.

As per our credit policy, *further credit orders may be put on hold until the overdue amount is cleared.*

If there is any genuine issue, please let us know so we can resolve it. Please tap an option below; if already paid, kindly share the payment reference in reply.

Regards,
*Accounts Department*
*Mahek Marketing India*$b$, 'personal', true, 'payment_credit_hold'
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" WHERE "id" = 'tpl_wati_payment_credit_hold');
--> statement-breakpoint
INSERT INTO "wa_templates" ("id", "name", "category", "body", "applies_to", "active", "wati_spec")
SELECT 'tpl_wati_order_reminder_due', 'Order reminder (due)', 'routine_check_in', $b$*ORDER REMINDER – {{customer_name}}*

Dear Sir/Madam,

As per your usual buying pattern, your next order is due around *{{expected_order_date}}*.

*Last order:* {{last_order_date}}
*Products:* {{last_products}}

Shall we arrange your material? Please tap an option below.

Regards,
*Mahek Marketing India*$b$, 'personal', true, 'order_reminder_due'
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" WHERE "id" = 'tpl_wati_order_reminder_due');
--> statement-breakpoint
INSERT INTO "wa_templates" ("id", "name", "category", "body", "applies_to", "active", "wati_spec")
SELECT 'tpl_wati_order_followup_due_passed', 'Order follow-up (due date passed)', 'reactivation', $b$*ORDER FOLLOW-UP – {{customer_name}}*

Dear Sir/Madam,

Your usual buying cycle is about *{{cycle_days}} days*, and your next order was expected around *{{expected_order_date}}*. We have not received it yet.

*Last order:* {{last_order_date}} ({{days_since_last_order}} days ago)
*Products:* {{last_products}}

Kindly let us know if you need any material, or if your requirement has changed. Please tap an option below.

Regards,
*Mahek Marketing India*$b$, 'personal', true, 'order_followup_due_passed'
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" WHERE "id" = 'tpl_wati_order_followup_due_passed');
--> statement-breakpoint
INSERT INTO "wa_templates" ("id", "name", "category", "body", "applies_to", "active", "wati_spec")
SELECT 'tpl_wati_order_followup_cycle_exceeded', 'Order follow-up (cycle exceeded)', 'reactivation', $b$*IMPORTANT ORDER FOLLOW-UP – {{customer_name}}*

Dear Sir/Madam,

Your regular buying cycle has been exceeded.

*Last order:* {{last_order_date}}
*Usual buying cycle:* {{cycle_days}} days
*Expected order date:* {{expected_order_date}}
*Days since last order:* {{days_since_last_order}}

Your previous order included: *{{last_products}}*

Please share your current requirement so we can plan the material for you, or let us know if your purchasing plan has changed. Please tap an option below.

Regards,
*Mahek Marketing India*$b$, 'personal', true, 'order_followup_cycle_exceeded'
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" WHERE "id" = 'tpl_wati_order_followup_cycle_exceeded');
--> statement-breakpoint
INSERT INTO "wa_templates" ("id", "name", "category", "body", "applies_to", "active", "wati_spec")
SELECT 'tpl_wati_customer_followup_gap', 'Customer follow-up (long gap)', 'reactivation', $b$*CUSTOMER FOLLOW-UP – {{customer_name}}*

Dear Sir/Madam,

We have not received an order from you for *{{days_since_last_order}} days*, while your usual buying cycle is about *{{cycle_days}} days*.

*Last order:* {{last_order_date}}
*Products:* {{last_products}}
*Order value:* ₹{{last_order_value}}

We would like to understand if anything has changed. Please tap an option below — if something has changed, tap *Share a reason* and choose from the list.

Your feedback helps us serve you better.

Regards,
*Mahek Marketing India*$b$, 'personal', true, 'customer_followup_gap'
WHERE NOT EXISTS (SELECT 1 FROM "wa_templates" WHERE "id" = 'tpl_wati_customer_followup_gap');
--> statement-breakpoint
-- Every older free-text template is retired: from here on WhatsApp goes out
-- only as one of the eight above. ARCHIVED, not deleted — wa_messages keeps a
-- foreign key to the template each message was sent from, and a history that
-- can no longer say which template a message used is a history with a hole.
-- Archived templates are offered nowhere and cannot be sent.
UPDATE "wa_templates"
SET "active" = false, "updated_at" = now()
WHERE "wati_spec" IS NULL AND "active" = true;
