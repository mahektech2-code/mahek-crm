# ERP units of measure, can photos and groups

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A QUANTITY IS STORED IN ONE BASE UNIT AND TYPED IN ANY UNIT OF ITS KIND.**
The ledgers add figures up, so every ERP quantity is still kept in the base
of its measure — kg for weight, litres for volume, pieces for a count (cans,
boxes, drums) — and no schema or check constraint changed. What changed is the
typing: `erp_uoms` (0310, Masters → Reference lists → **Units**) lists every
unit a quantity may be entered in, each saying what it measures and how many
base units one of it is — Gram 0.001 kg, Drum (200 L) 200 litres, Dozen 12.
The three base units (Kg, Litre, Pcs) are built in and cannot be changed or
retired. Rules are pure in `engines/uom.ts`; reads and writes in `uoms.ts`.

**THE BOX CONVERTS, SO NOTHING DOWNSTREAM KNOWS.** A `num` field that is a
quantity draws a searchable unit dropdown beside it (`_ui/units.tsx`, in the
generic field, the line table, the GRN dialog and every prompt) and hands the
form the figure ALREADY IN THE BASE — calculators, min/max checks and every
server handler read exactly what they always read. A field is a quantity when
its label carries a base unit in brackets ("Quantity (litres)", "(kg)",
"(cans)"), or when its spec says so: `qtyUnit: { base }`, `{ of: "<field>" }`
(the item's unit field) or `{ by, map }` (looked up like `fillBy`);
`qtyUnit: false` for a number that is not a quantity. `resolveField` puts the
resolved base on the spec as `ub`. **A new quantity field needs one of these**,
or it is a bare number. Weight and volume are never converted into each other
here — that needs the item's density, which is the register's job.

**ANYBODY IN THE ERP ADDS A UNIT FROM THE DROPDOWN** ("Add “…”" when a search
finds none — `erpAddUom`, audited, refused while previewing); editing and
retiring are on the Units tab. Re-sizing a unit moves nothing already saved:
the figure was converted when it was typed. The units reach the browser from
the ERP layout (`UnitsProvider`); outside it — HRMS draws the same fields —
a box is the plain number it always was. The factory phone is not on this yet.

## Can photos and groups

**A CAN IS RECOGNISED BY SIGHT, SO IT CARRIES PHOTOS AND A GROUP.** Raw
materials of type Can take up to three photos each ("Photos" on the row,
attachments under `erp_raw_material`), and belong to at most one look-alike
group (`erp_raw_materials.group_id` → `erp_material_groups`, 0263): one print
in several sizes — "Mahek Yellow", "Naked". A group has a name anybody holding
Raw materials can change, up to three photos of its own
(`erp_material_group`), and its members. Both photo kinds are read under the
Raw materials screen; taking one off marks it removed, never deletes it
(`lib/erp/can-photos.ts`). The limits are `MAX_CAN_PHOTOS` and
`MAX_GROUP_PHOTOS`.

**GROUPS ARE A TAB, AND GROUPING BY NAME IS A SUGGESTION.** Raw materials →
Can groups (`screens/can-groups.ts`) draws each group as a card with its photo
(else its first can's). "Group cans by name" reads each ungrouped active can's
FAMILY — its name with the size and the words every can carries taken out
(`engines/can-groups.ts`, pure) — joins it to an existing group of that family,
or makes a new group where two or more share one. It never moves a can
somebody already grouped (`group_id is null` is in the write too), leaves a
can whose name is only a size, and lists what it left. A mistake is fixed by
Edit group (rename, tick the cans — ticking one moves it here), Rename, Delete
group (its cans stay, not grouped), or a can's own Edit form.
