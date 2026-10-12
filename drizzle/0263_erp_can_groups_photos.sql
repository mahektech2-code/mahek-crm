-- Cans carry photographs, and are gathered into groups of look-alikes.
-- A raw material of type Can takes up to three photos; a group takes up to
-- three photos of its own and a name somebody can change. Grouping by name is
-- a SUGGESTION that only ever fills cans nobody has grouped — a can somebody
-- moved stays where they put it. See "Can photos and groups" in AGENTS.md.
CREATE TABLE IF NOT EXISTS "erp_material_groups" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "material_type" text NOT NULL DEFAULT 'Can',
  "remark" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text,
  "updated_by_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_material_groups_name_key" ON "erp_material_groups" ("material_type", lower("name"));
--> statement-breakpoint
ALTER TABLE "erp_raw_materials" ADD COLUMN IF NOT EXISTS "group_id" text REFERENCES "erp_material_groups"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_raw_materials_group_idx" ON "erp_raw_materials" ("group_id");
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_raw_material';
--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE IF NOT EXISTS 'erp_material_group';
