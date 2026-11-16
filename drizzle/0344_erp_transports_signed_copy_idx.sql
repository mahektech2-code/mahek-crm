-- Every LR list (the Documents desk, the upload button on Logistics and the
-- Dispatch desk) counts the bills under each LR, matching a transport on its
-- LR or on its signed copy. Only lr_id had an index, so the OR read every
-- transport ever made once per LR listed: 300 LRs on the upload button, 1,500
-- on the Documents desk. With this the two halves are two index probes.
CREATE INDEX IF NOT EXISTS "erp_transports_signed_copy_idx" ON "erp_transports" ("signed_copy_id") WHERE "signed_copy_id" IS NOT NULL;
