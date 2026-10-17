-- Who may act in purchase is set in the Admin Console and nowhere else. The
-- per-material "Who does what" layer (0235) is gone with its screens; what was
-- set in it stays readable in audit_log (erp.rawMaterial.duties).
DROP TABLE IF EXISTS "erp_material_duties";
