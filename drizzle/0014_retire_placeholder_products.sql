-- The sixteen placeholder products that shipped before the real product
-- master existed. They were a stand-in — "NC Thinner 20L", "Acetone",
-- "Toluene" — and with the catalogue imported they sit in the order form
-- beside two hundred real SKUs, which is how a telecaller captures an order
-- against a product Mahek does not sell under that name.
--
-- Deactivated, never deleted: four of them carry order lines, and a product a
-- historical order cannot resolve turns that order into a row naming nothing.
-- They leave the order form and stay readable everywhere else.
--
-- Matched on the external codes the old seed wrote, so this touches exactly
-- those rows and nothing a real deployment may have added by hand. Re-running
-- it changes nothing.
update products
   set active = false,
       updated_at = now()
 where finished_good_id is null
   and external_code in (
     'MUT-5', 'MUT-20', 'MUT-200',
     'NC-5', 'NC-20', 'NC-200',
     'MTO-20', 'MTO-200',
     'PU-5', 'PU-20',
     'LOT-20', 'EPX-20', 'ACE-20',
     'TOL-200', 'MTUR-200', 'WP-20'
   )
   and active = true;
