-- Credentials for outside services, set from the Admin Console.
--
-- Separate from `app_settings` on purpose: settings are rendered on screens,
-- exported as JSON, and audited with their before and after values. A key
-- stored there would be readable in four places, one of them a log nobody
-- prunes. Nothing selects `value` except the code about to make the call.
--
-- The generator also offered the customer columns from 0030/0031 and an
-- app_id enum rewrite — those are already applied and the snapshot had simply
-- fallen behind. Re-running them would drop and rebuild a live enum for
-- nothing, so this migration carries only the new table.
CREATE TABLE "app_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"last4" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text
);
