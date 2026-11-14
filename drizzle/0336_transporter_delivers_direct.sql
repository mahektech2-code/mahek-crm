-- A TRANSPORTER THAT DELIVERS STRAIGHT TO THE SHOP, with no LR.
--
-- The floor dispatches local deliveries in a hired tempo, recorded against the
-- transporter `"Name - Tempo"` with the tempo's plate. A tempo issues no LR, so
-- every one of those bills sat at "At transport" waiting for paper that never
-- comes, and was closed by hand. `delivers_direct` marks such a transporter:
-- its bills travel like Mahek Vehicle's (no LR wait, a signed copy is their
-- proof) and keep their own name on the screens.
--
-- The one transporter that is this today is switched on by name. Anything
-- else is a decision for the transporter list.
ALTER TABLE "erp_transporters" ADD COLUMN IF NOT EXISTS "delivers_direct" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "erp_transporters" SET "delivers_direct" = true WHERE lower(trim("name")) = '"name - tempo"';
