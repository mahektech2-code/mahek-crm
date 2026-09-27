-- The ERP's attachment parents. On their own, ahead of the tables that use
-- them: a value added to an enum cannot be USED in the transaction that adds
-- it, and drizzle-kit applies every pending migration in one.
alter type "public"."attachment_parent" add value if not exists 'erp_test';
alter type "public"."attachment_parent" add value if not exists 'erp_purchase';
alter type "public"."attachment_parent" add value if not exists 'erp_request';
alter type "public"."attachment_parent" add value if not exists 'erp_transport';
alter type "public"."attachment_parent" add value if not exists 'erp_video';
