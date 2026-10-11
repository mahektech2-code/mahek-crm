-- A salesman may have SEVERAL hometowns, and a day in any of them is a day at
-- home. One row per town now, keyed on (user, town) rather than on the user.
-- Every existing row stays as it is: one hometown is simply a set of one.
ALTER TABLE expense_hometowns DROP CONSTRAINT IF EXISTS expense_hometowns_pkey;
--> statement-breakpoint
ALTER TABLE expense_hometowns ADD CONSTRAINT expense_hometowns_pkey PRIMARY KEY (user_id, city);
