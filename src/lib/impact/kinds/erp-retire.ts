import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { money } from "@/lib/format";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { erpMayDelete, many, present } from "./erp-common";

/* ---------------------------------------------------------------------------
 * RETIRING A MASTER IS NOT DELETING IT, and the modal exists to say both
 * halves. A retired raw material or supplier stays on every record that names
 * it and stops being offered on new ones — which is exactly the part people
 * get wrong in both directions: they expect the open requisition, the PO in
 * flight and the recipe to go with it (they do not), and they do not expect a
 * raw material's preferred vendor to go on pointing at a supplier nobody can
 * pick any more (it does).
 *
 * Deactivating a party reaches further, because a party is a MahekOne
 * customer: the CRM stops calling it and the order desk stops taking its
 * orders, while what it already owes and has on order stands.
 * ------------------------------------------------------------------------- */

/** Open purchase-order states — the PO is still expecting goods. */
const PO_OPEN = sql`('Pending approval', 'Approved', 'Sent', 'Partly received')`;

/** The words a record is offered under when it fits on a line; the verb in capitals otherwise. */
const word = (name: string, verb: string) => (name.length <= 40 ? name : verb.toUpperCase());

/* ======================================================== a raw material */

export const rawMaterialRetireImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["rawMaterials"]);
  },

  async report(id) {
    const [m] = await db.execute<{ name: string; active: boolean; type: string; reqs: number; pos: number; recipes: number; levels: number; grouped: boolean }>(sql`
      select m.name, m.active, m.material_type as type,
             (select count(*)::int from erp_requisitions r where r.raw_material_id = m.id and r.status not in ('Cancelled', 'Received', 'Closed')) as reqs,
             (select count(distinct l.po_id)::int from erp_po_lines l join erp_purchase_orders o on o.id = l.po_id
               where l.raw_material_id = m.id and o.status in ${PO_OPEN}) as pos,
             (select count(*)::int from erp_recipes x where x.raw_material_id = m.id) as recipes,
             (select count(*)::int from erp_rm_levels v where v.raw_material_id = m.id) as levels,
             m.group_id is not null as grouped
        from erp_raw_materials m
       where m.id = ${id}`);
    if (!m) return null;
    const recipes = m.recipes ? await db.execute<{ name: string }>(sql`
      select distinct f.name from erp_recipes x join product_formulations f on f.id = x.formulation_id where x.raw_material_id = ${id} order by f.name limit 5`) : [];

    const items: ImpactItem[] = [
      {
        app: "ERP",
        label: "raw material stops being offered on new requisitions, purchases, inward lines and recipes",
        effect: "changed",
        count: m.active ? 1 : 0,
        note: "Restore brings it back. Its stock stays on the shelf and can still be used and moved.",
      },
      {
        app: "ERP",
        label: `open ${many(Number(m.reqs), "requisition")} for it`,
        effect: "kept",
        count: Number(m.reqs),
        note: "They go on to be bought and received as they are.",
      },
      {
        app: "ERP",
        label: `open purchase ${many(Number(m.pos), "order")} with it on a line`,
        effect: "kept",
        count: Number(m.pos),
        note: "The goods are still expected and are received against the PO.",
      },
      {
        app: "ERP",
        label: `recipe ${many(Number(m.recipes), "line")} that use it`,
        effect: "kept",
        count: Number(m.recipes),
        examples: recipes.map((r) => r.name),
        note: "Batches made to those recipes still consume it. Change the recipes if it is being replaced.",
      },
      {
        app: "ERP",
        label: `re-order ${many(Number(m.levels), "level")} set for it`,
        effect: "kept",
        count: Number(m.levels),
      },
    ];
    if (m.grouped && m.type === "Can") items.push({ app: "ERP", label: "can group it belongs to", effect: "kept", count: 1 });

    return { title: m.name, verb: "Retire", confirmWord: word(m.name, "retire"), items: present(items), blockers: [] };
  },
};

/* ============================================================== a supplier */

export const supplierRetireImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["suppliers"]);
  },

  async report(id) {
    const [s] = await db.execute<{ name: string; active: boolean; pos: number; preferred: number; drums: number; returns: number }>(sql`
      select s.name, s.active,
             (select count(*)::int from erp_purchase_orders o where o.supplier_id = s.id and o.status in ${PO_OPEN}) as pos,
             (select count(*)::int from erp_raw_materials m where m.preferred_supplier_id = s.id and m.active) as preferred,
             (select count(*)::int from erp_empty_drums d where d.supplier_id = s.id and d.status = 'returnable') as drums,
             (select count(*)::int from erp_purchase_returns r where r.supplier_id = s.id and r.status not in ('cancelled', 'rejected')) as returns
        from erp_suppliers s
       where s.id = ${id}`);
    if (!s) return null;
    const preferred = Number(s.preferred)
      ? await db.execute<{ name: string }>(sql`select name from erp_raw_materials where preferred_supplier_id = ${id} and active order by name limit 5`)
      : [];

    return {
      title: s.name,
      verb: "Retire",
      confirmWord: word(s.name, "retire"),
      items: present([
        {
          app: "ERP",
          label: "supplier stops being offered on new purchase orders and inward lines",
          effect: "changed",
          count: s.active ? 1 : 0,
          note: "Existing purchases keep the name. Restore brings it back.",
        },
        {
          app: "ERP",
          label: `raw ${many(Number(s.preferred), "material")} naming it as the preferred vendor`,
          effect: "kept",
          count: Number(s.preferred),
          examples: preferred.map((m) => m.name),
          note: "Their purchase rule still points at it, though it can no longer be picked on a new PO — choose another vendor on each.",
        },
        {
          app: "ERP",
          label: `open purchase ${many(Number(s.pos), "order")} to it`,
          effect: "kept",
          count: Number(s.pos),
          note: "The goods are still expected and are received against the PO.",
        },
        {
          app: "ERP",
          label: `returnable ${many(Number(s.drums), "drum")} waiting to go back to it`,
          effect: "kept",
          count: Number(s.drums),
          note: "They can still be returned on Drum returns.",
        },
        {
          app: "ERP",
          label: `open vendor ${many(Number(s.returns), "return")} to it`,
          effect: "kept",
          count: Number(s.returns),
        },
      ]),
      blockers: [],
    };
  },
};

/* ============================================================ a party */

export const partyDeactivateImpact: ImpactSource = {
  authorize: async () => {
    await erpMayDelete(["customers"], (ctx) => (ctx.powers.has("customerStatus") ? null : "Only an admin or the office changes a customer's status."));
  },

  async report(id) {
    const [c] = await db.execute<{ name: string; status: string; open: number; owed: string; bills: number }>(sql`
      select c.name, c.status,
             (select count(*)::int from erp_orders o where o.billing_customer_id = c.id and o.status <> 'Cancel'
                 and not exists (select 1 from erp_order_details d where d.order_id = o.id and d.verification = 'Verified')) as open,
             c.outstanding as owed,
             (select count(*)::int from bills b where b.customer_id = c.id and b.amount > b.paid_amount and b.payment_position = 'stated') as bills
        from customers c
       where c.id = ${id}`);
    if (!c) return null;
    const live = c.status !== "deactivated";
    const open = Number(c.open);
    const orders = open
      ? await db.execute<{ no: number }>(sql`
          select distinct o.order_no as no from erp_orders o where o.billing_customer_id = ${id} and o.status <> 'Cancel'
             and not exists (select 1 from erp_order_details d where d.order_id = o.id and d.verification = 'Verified')
           order by o.order_no desc limit 5`)
      : [];

    return {
      title: c.name,
      verb: "Deactivate",
      confirmWord: word(c.name, "deactivate"),
      items: present([
        {
          app: "ERP",
          label: "party stops being offered on new orders — an order for it is refused",
          effect: "changed",
          count: live ? 1 : 0,
          note: "Activate brings it back.",
        },
        {
          app: "CRM",
          label: "customer leaves the Call Log and the automatic WhatsApp reminders",
          effect: "changed",
          count: live ? 1 : 0,
          note: "A deactivated account is never chased. Nothing recomputes it back to active — only Activate does.",
        },
        {
          app: "ERP",
          label: `open order ${many(open, "line")} not yet dispatched`,
          effect: "kept",
          count: open,
          examples: orders.map((o) => `order ${o.no}`),
          note: "They are not cancelled: they can still be billed and dispatched. Cancel them on Sales if they should not go.",
        },
        {
          app: "Accounts",
          label: `unpaid ${many(Number(c.bills), "bill")} — ${money(Number(c.owed))} outstanding`,
          effect: "kept",
          count: Number(c.bills),
          note: "Still owed. Deactivating says nothing about the money.",
        },
      ]),
      blockers: [],
    };
  },
};
