-- A hometown is PICKED from the reviewed place tree (state › district › city),
-- never typed, so it names a node. `city` stays the name the pay rule compares
-- against the towns of the shops he visited; `state` is the branch it was picked
-- under. A row typed before this keeps its name and no place, and the screens
-- say it was typed.
ALTER TABLE expense_hometowns ADD COLUMN IF NOT EXISTS place_id text REFERENCES places(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE expense_hometowns ADD COLUMN IF NOT EXISTS state text;
--> statement-breakpoint
-- A typed town that names exactly one city in the tree is that city.
UPDATE expense_hometowns h
   SET place_id = m.id, city = m.name, state = m.state
  FROM (
    select h2.user_id, min(c.id) as id, min(c.name) as name, min(s.name) as state
      from expense_hometowns h2
      join places c on c.kind = 'city'
                   and c.key = regexp_replace(lower(h2.city), '[^a-z0-9]', '', 'g')
      left join places d on d.id = c.parent_id
      left join places s on s.id = coalesce(d.parent_id, c.parent_id) and s.kind = 'state'
     where h2.place_id is null
     group by h2.user_id
    having count(*) = 1
  ) m
 WHERE m.user_id = h.user_id;
