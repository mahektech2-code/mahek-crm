-- Studio Timeline: the bulk poster run. Three more things a person does that are NOT a send:
--   batch_generated      somebody generated a bulk run (one row for the run; no recipient is invented),
--   zip_downloaded       a ZIP was downloaded, one row per poster-recipient pair it contained,
--   zip_downloaded_batch a ZIP was downloaded with no usable recipient mapping: one row for the whole run.
-- and the 'studio' channel for the first. Only the two CHECK constraints widen; no column, row or index changes.

ALTER TABLE "studio_activities" DROP CONSTRAINT IF EXISTS "studio_activities_channel";
ALTER TABLE "studio_activities" ADD CONSTRAINT "studio_activities_channel" CHECK ("channel" in ('kapso','whatsapp_chat','download','device','studio'));
ALTER TABLE "studio_activities" DROP CONSTRAINT IF EXISTS "studio_activities_action";
ALTER TABLE "studio_activities" ADD CONSTRAINT "studio_activities_action" CHECK ("action" in ('kapso_handed','not_sent','chat_opened','marked_sent','marked_skipped','marked_undone','downloaded','shared_device','batch_generated','zip_downloaded','zip_downloaded_batch'));
