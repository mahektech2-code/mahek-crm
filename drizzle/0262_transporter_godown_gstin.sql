-- Each of a transporter's godowns has its own GST number (GST is registered
-- per state). Null on godowns saved before it was asked; the godown dialog
-- asks for it, with the city and the area, the next time one is edited.
ALTER TABLE "erp_transporter_godowns" ADD COLUMN IF NOT EXISTS "gstin" text;
