CREATE TABLE "impersonation_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_by_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "impersonation_tokens" ADD CONSTRAINT "impersonation_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_tokens" ADD CONSTRAINT "impersonation_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "impersonation_tokens_token_key" ON "impersonation_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "impersonation_tokens_user_idx" ON "impersonation_tokens" USING btree ("user_id");
