-- §2.2 Product search has to survive a name typed mid-call, so matching is
-- trigram similarity rather than LIKE alone. The GIN indexes are declared here
-- rather than in schema.ts because Drizzle cannot express an operator-class
-- index, and the extension has to exist before they can be built.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS products_name_trgm_idx
  ON products USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS products_pack_size_trgm_idx
  ON products USING gin (pack_size gin_trgm_ops);

-- §2.1 The frequent-products aggregation reads external order lines, which
-- live in JSON. Without this, every lookup sequentially scans the customer's
-- orders to reach them.
CREATE INDEX IF NOT EXISTS orders_customer_source_idx
  ON orders (customer_id, source);

-- §3.2 The old No Order quick notes are DEACTIVATED, never deleted —
-- historical interactions reference these identifiers and those references
-- must keep resolving. They simply stop being offered.
UPDATE quick_notes
   SET active = false
 WHERE interaction_type = 'outbound_call'
   AND outcome = 'no_order'
   AND label IN (
     'Comparing competitor rates',
     'Stock available',
     'Price high',
     'Needs approval',
     'Will order later'
   );

-- The six replacements. "Will order later" is seeded fresh rather than
-- reactivated: the old row belongs to the multi-select era, and reusing it
-- would blur which scheme an interaction was recorded under.
INSERT INTO quick_notes (id, interaction_type, outcome, label, display_order, active)
SELECT 'qn_no_' || ordinality, 'outbound_call', 'no_order', label, ordinality - 1, true
  FROM unnest(ARRAY[
    'Stock sufficient',
    'Price issue',
    'Will order later',
    'Not interested',
    'Buying elsewhere',
    'Business slow'
  ]) WITH ORDINALITY AS t(label, ordinality)
 WHERE NOT EXISTS (
   SELECT 1 FROM quick_notes q
    WHERE q.interaction_type = 'outbound_call'
      AND q.outcome = 'no_order'
      AND q.label = t.label
      AND q.active = true
 );
