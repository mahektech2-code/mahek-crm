-- A new kind of business: "Private Limited(User)". Additive; the value is
-- only added here, never used in this migration.
ALTER TYPE "customer_type" ADD VALUE IF NOT EXISTS 'private_limited_user';
