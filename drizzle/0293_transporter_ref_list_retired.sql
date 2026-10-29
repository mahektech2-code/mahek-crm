-- ONE LIST OF TRANSPORTERS: ERP -> Logistics -> Transporters (erp_transporters).
--
-- ERP -> Settings carried a second, free "Transporter" value list, seeded from
-- the Sales Party sheet's Transport Detail. Every transporter box now offers
-- and checks erp_transporters alone, so that list is dropped from the screen
-- and its values go with it. Nothing reads them: records carry the name as
-- text, and a rename or merge on the Transporters tab is what corrects one.
delete from erp_ref_values where list_key = 'transporter';
