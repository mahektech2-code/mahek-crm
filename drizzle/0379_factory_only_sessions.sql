-- A session opened on the factory floor with a 4-digit PIN (or the SMS code that
-- stands in for a forgotten PIN) is good for the Factory app ONLY. It used to be
-- the ordinary whole-site session, already marked password-confirmed, so a
-- Production Head or an admin who also held Factory was signed in to every app,
-- the Admin Console included, on four digits. `getCurrentUser` answers nobody
-- for a factory-only session anywhere outside /factory and /api/factory.
-- Every existing session stays whole-site, so nobody is signed out by this.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "factory_only" boolean DEFAULT false NOT NULL;
