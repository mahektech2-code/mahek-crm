-- Transport and other direct inward cost, once per PR. Landing cost = material
-- + transport + other; each lot's share is worked out on read, by value.
CREATE TABLE IF NOT EXISTS "erp_pr_costs" (
  "pr_number" integer PRIMARY KEY NOT NULL,
  "transport_mode" text NOT NULL,
  "transport_cost_paise" bigint DEFAULT 0 NOT NULL,
  "km" numeric(10, 1),
  "rate_per_km_paise" bigint,
  "tempo_number" text,
  "other_cost_paise" bigint DEFAULT 0 NOT NULL,
  "other_cost_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_pr_costs_mode_check" CHECK ("transport_mode" in ('supplier', 'own_vehicle', 'third_party', 'none')),
  CONSTRAINT "erp_pr_costs_amounts_check" CHECK ("transport_cost_paise" >= 0 and "other_cost_paise" >= 0),
  CONSTRAINT "erp_pr_costs_own_vehicle_check" CHECK ("transport_mode" <> 'own_vehicle' or ("km" is not null and "rate_per_km_paise" is not null)),
  CONSTRAINT "erp_pr_costs_none_check" CHECK ("transport_mode" <> 'none' or "transport_cost_paise" = 0)
);

-- The empty drum weight read at the gate, per drum: a kg line's net quantity
-- is weight with drum minus drums × this.
ALTER TABLE "erp_inward" ADD COLUMN IF NOT EXISTS "empty_drum_weight" numeric(10, 3);
