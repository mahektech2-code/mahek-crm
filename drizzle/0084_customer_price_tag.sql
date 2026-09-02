-- The tier mbos_price_list is keyed on, mirrored onto the customer it names.
--
-- mbos_price_list.customer_price_tag matches sheet_party_rows.tag_pricelist,
-- and until now nothing joined that tag to a real customer id — a price list
-- keyed on "DEALER" had no way to reach any particular dealer's order. The
-- party projection is what already fills phone, WhatsApp and the sales rep
-- link from the same sheet by the same name match; this column rides along
-- with it rather than inventing a second way to link a customer to the sheet.
ALTER TABLE customers ADD COLUMN price_tag text;
