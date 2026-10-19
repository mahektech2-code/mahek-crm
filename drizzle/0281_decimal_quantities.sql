-- Litres, kilometres and one percentage take a fraction. Every value already
-- stored is a whole number and is unchanged by the cast. Double precision
-- rather than numeric: these come back as JS numbers through raw SQL and on
-- the handset wire, where numeric would arrive as "200.00". None is money —
-- money stays paise.
ALTER TABLE "customers" ALTER COLUMN "lead_monthly_volume_litres" TYPE double precision;--> statement-breakpoint
ALTER TABLE "distributor_profiles" ALTER COLUMN "storage_capacity_litres" TYPE double precision;--> statement-breakpoint
ALTER TABLE "distributor_profiles" ALTER COLUMN "special_discount_percent" TYPE double precision;--> statement-breakpoint
ALTER TABLE "mbos_expense_days" ALTER COLUMN "opening_odometer_km" TYPE double precision;--> statement-breakpoint
ALTER TABLE "mbos_expense_days" ALTER COLUMN "closing_odometer_km" TYPE double precision;--> statement-breakpoint
ALTER TABLE "mbos_travel_legs" ALTER COLUMN "odometer_start_km" TYPE double precision;--> statement-breakpoint
ALTER TABLE "mbos_travel_legs" ALTER COLUMN "odometer_end_km" TYPE double precision;--> statement-breakpoint
ALTER TABLE "mbos_evidence_reviews" ALTER COLUMN "reported_km" TYPE double precision;--> statement-breakpoint
ALTER TABLE "mbos_evidence_reviews" ALTER COLUMN "corrected_km" TYPE double precision;--> statement-breakpoint
ALTER TABLE "mbos_lead_validations" ALTER COLUMN "confirmed_monthly_volume_litres" TYPE double precision;--> statement-breakpoint
ALTER TABLE "price_list_discount_terms" ALTER COLUMN "threshold_litres" TYPE double precision;
