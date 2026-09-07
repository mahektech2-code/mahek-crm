-- The content hash of a stored file.
--
-- Requirement 47 — spotting a bill claimed twice. A hash is a property of the
-- FILE rather than of the claim, so it lives beside the bytes and every claim
-- naming that file reads the same one; putting it on `mbos_expenses` alone
-- would mean two claims of one photograph carrying two independently computed
-- answers, which is precisely the shape of thing that drifts.
--
-- **It is an exact content hash, not a perceptual one, and the difference
-- matters.** It catches the same FILE claimed twice — a retried submission, a
-- photograph attached to two days, one bill sent by two salesmen. It does NOT
-- catch the same bill photographed a second time, which a perceptual hash
-- would; that needs an image decoder in the container, and this deployment's
-- registry quota is already the thing breaking deploys. The screens say which
-- kind of match they found, so nobody reads more into it than it means.
--
-- Nullable and backfilled by nothing: an old attachment has no hash and takes
-- part in no duplicate check, which is honest. Hashing every file already
-- stored would mean reading every byte out of the store to answer a question
-- about claims nobody is making any more.

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS content_hash text;
--> statement-breakpoint

-- Not unique: the same file legitimately arrives twice, and refusing the
-- second upload would break a resumed one. This index is for the lookup that
-- asks "has this person claimed this file before".
CREATE INDEX IF NOT EXISTS attachments_content_hash_idx
  ON attachments (content_hash) WHERE content_hash IS NOT NULL;
