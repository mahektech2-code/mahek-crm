-- WHAT A CUSTOMER SENT THAT WAS NOT WORDS. A photograph of a payment slip or a
-- PDF of a statement arrived on the webhook with Wati's file path in `data`,
-- and the path was dropped: the chat showed "[image]" and nobody could see
-- what had been sent. The kind (image, document, video, audio, sticker) and
-- Wati's own path to the file are kept now; the bytes stay with Wati and are
-- fetched through MahekOne only by somebody who may open the conversation.
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS media_type text;
--> statement-breakpoint
ALTER TABLE wa_replies ADD COLUMN IF NOT EXISTS media_path text;
