-- Documentation: its own MahekOne app, at /docs.
--
-- The app id is added here and USED nowhere in this file: a value added to an
-- enum cannot be used in the transaction that adds it, and drizzle-kit runs
-- every pending migration in one. Granting it is `npm run app:grant -- docs`
-- or the Access screen, after this has committed.
alter type "public"."app_id" add value if not exists 'docs';
