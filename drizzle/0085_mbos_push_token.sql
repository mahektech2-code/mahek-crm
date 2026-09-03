-- Expo's own push token for a handset, not APNs/FCM directly.
--
-- Set from its own endpoint rather than only at sign-in: the token is not
-- known yet at login time (it is requested after notification permission is
-- granted, a step after the app opens) and Expo can rotate it without a new
-- sign-in, so a device row has to be updatable outside the login path.
--
-- IF NOT EXISTS: see 0080's own note.
ALTER TABLE mbos_devices ADD COLUMN IF NOT EXISTS push_token text;
