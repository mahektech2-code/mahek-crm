-- The live bell asks for one person's newest thirty every few seconds from
-- every open tab. The (user_id, read) index cannot order them, so each ask
-- sorted every notification that person ever had.
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC);
