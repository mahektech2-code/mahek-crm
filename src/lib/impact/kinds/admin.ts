import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, appSecrets, productAliases, products, users } from "@/db/schema";
import { ASSIGNED_TO_SQL, isPlatformAdmin, requireCapability, requirePlatformAdminUser } from "@/lib/access-control";
import { getApp } from "@/lib/apps";
import { requireUser } from "@/lib/auth";
import { ConsoleNotConfirmedError, isConsoleConfirmed } from "@/lib/console-confirm";
import { isSecretName, SECRET_NAMES, type SecretName } from "@/lib/secrets";
import type { ImpactItem } from "../types";
import { accessRevokeParts } from "./access-revoke-key";
import type { ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * WHAT THE ADMIN CONSOLE'S REMOVALS REACH.
 *
 * The console is where settings live, and a setting removed here is felt
 * somewhere else: an alias is how a year of order lines written with an old
 * spelling still count as the SKU, a retired SKU leaves every order form and
 * every handset, a disabled sign-in shuts a phone out mid-beat, and a cleared
 * key switches a feature off — or quietly hands it to a key the deployment
 * holds, which is the half nobody expects.
 *
 * Each source asks the permission its act asks.
 * ------------------------------------------------------------------------- */

/** The record's own short name where somebody can type it; the verb otherwise. */
const typeable = (name: string, verb: string) => (name.trim() && name.length <= 40 ? name : verb);

/** The join key the order sheet's lines are matched on — the same squeeze `eod-service` and `product-service` apply. */
const squeeze = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Order lines that name a product by this spelling, from the sheet and the handset alike. */
async function linesNaming(spelling: string): Promise<{ lines: number; shops: number }> {
  const [row] = await db.execute<{ lines: number; shops: number }>(sql`
    select count(*)::int as lines, count(distinct o.customer_id)::int as shops
      from orders o, jsonb_array_elements(coalesce(o.line_items, '[]'::jsonb)) as li
     where lower(regexp_replace(li ->> 'product', '[^a-zA-Z0-9]', '', 'g')) = ${squeeze(spelling)}
  `);
  return { lines: Number(row?.lines ?? 0), shops: Number(row?.shops ?? 0) };
}

const catalogueWriter = async () => {
  await requireCapability("config.write");
};

/* ---------------------------------------------------------------- an alias */

/** `admin-catalogue-alias` — `removeAlias`. */
export const aliasImpact: ImpactSource = {
  authorize: catalogueWriter,
  async report(id) {
    const [row] = await db
      .select({ name: productAliases.name, product: products.name })
      .from(productAliases)
      .innerJoin(products, eq(products.id, productAliases.productId))
      .where(eq(productAliases.id, id));
    if (!row) return null;
    /* A line spelled exactly as the SKU itself still resolves without the alias. */
    const { lines, shops } = squeeze(row.name) === squeeze(row.product) ? { lines: 0, shops: 0 } : await linesNaming(row.name);
    const items: ImpactItem[] = [
      {
        app: "Admin Console",
        label: "alias",
        effect: "deleted",
        count: 1,
        examples: [`“${row.name}” → ${row.product}`],
      },
      {
        app: "CRM",
        label: lines === 1 ? "order line written with this spelling" : "order lines written with this spelling",
        effect: "unlinked",
        count: lines,
        note: `Across ${shops.toLocaleString("en-IN")} ${shops === 1 ? "shop" : "shops"}. They keep the words they were written with; product history, the salesmen's litres and mix, and the end-of-day box count stop counting them as ${row.product}.`,
      },
      {
        app: "CRM",
        label: "product search on the order form",
        effect: "changed",
        count: 1,
        note: `Typing “${row.name}” no longer finds ${row.product}.`,
      },
      {
        app: "Accounts",
        label: "price-list imports",
        effect: "changed",
        count: 1,
        note: "A price list read in from now on no longer recognises this spelling as the SKU.",
      },
    ];
    return { title: `“${row.name}”`, verb: "Remove", confirmWord: typeable(row.name, "REMOVE"), items, blockers: [] };
  },
};

/* ------------------------------------------------------------ a SKU retired */

/** `admin-sku-retire` — `setSkuActive(id, false)`. */
export const skuRetireImpact: ImpactSource = {
  authorize: catalogueWriter,
  async report(id) {
    const [row] = await db.select({ name: products.name, active: products.active }).from(products).where(eq(products.id, id));
    if (!row) return null;
    const [[counts], lists, phones] = await Promise.all([
      db.execute<{ calls: number }>(sql`
        select count(*)::int as calls from interaction_product_lines where product_id = ${id}
      `),
      db.execute<{ name: string }>(sql`
        select distinct l.name from price_list_rates r
          join price_lists l on l.id = r.price_list_id
         where r.product_id = ${id} and l.status = 'published'
         order by l.name
      `),
      db.execute<{ n: number }>(sql`
        select count(distinct d.user_id)::int as n from mbos_devices d
          join app_access a on a.user_id = d.user_id and a.app = 'field'
         where d.active
      `),
    ]);
    const sheet = await linesNaming(row.name);
    const ordered = Number(counts?.calls ?? 0) + sheet.lines;
    const salesmen = Number(phones[0]?.n ?? 0);

    const items: ImpactItem[] = [
      {
        app: "CRM",
        label: "order form and product search",
        effect: "changed",
        count: 1,
        note: "It stops being offered when an order is taken, and stops coming up in a search.",
      },
      {
        app: "ERP",
        label: "sales orders, stock movement and production",
        effect: "changed",
        count: 1,
        note: "Their product pick lists stop offering it.",
      },
      {
        app: "MBOS handsets",
        label: salesmen === 1 ? "salesman's order screen" : "salesmen's order screens",
        effect: "phones",
        count: salesmen,
        note: "Marked retired on the next sync, so it can no longer be put on an order from the field.",
      },
      {
        app: "Accounts",
        label: lists.length === 1 ? "published price list carrying a rate for it" : "published price lists carrying a rate for it",
        effect: "kept",
        count: lists.length,
        examples: lists.slice(0, 5).map((l) => l.name),
        note: "The rate stays on the list as it was published; nobody can order the product from it.",
      },
      {
        app: "CRM",
        label: ordered === 1 ? "past order line that names it" : "past order lines that name it",
        effect: "kept",
        count: ordered,
        note: "Retiring never deletes: past orders, bills and history keep naming it. Put it back on the order form at any time.",
      },
    ];
    return {
      title: row.name,
      verb: "Retire",
      confirmWord: typeable(row.name, "RETIRE"),
      items,
      blockers: row.active ? [] : ["It is already off the order form."],
    };
  },
};

/* ------------------------------------------------------ a sign-in disabled */

/** `admin-user-disable` — `setUserActive(id, false)`. A platform administrator's, as the act asks. */
export const userDisableImpact: ImpactSource = {
  async authorize() {
    await requirePlatformAdminUser();
  },
  async report(id) {
    const [person] = await db.select({ name: users.name, active: users.active }).from(users).where(eq(users.id, id));
    if (!person) return null;
    const me = await requireUser();
    const [[sessions], [devices], grants, book, admins] = await Promise.all([
      db.execute<{ n: number }>(sql`select count(*)::int as n from sessions where user_id = ${id}`),
      db.execute<{ n: number; models: string | null }>(sql`
        select count(*)::int as n, string_agg(coalesce(d.model, 'a phone'), ', ') as models
          from mbos_devices d where d.user_id = ${id} and d.active
      `),
      db.select({ app: appAccess.app, role: appAccess.role }).from(appAccess).where(eq(appAccess.userId, id)),
      db.execute<{ name: string; n: number }>(sql`
        select customers.name, count(*) over ()::int as n
          from customers
         where (${ASSIGNED_TO_SQL}) = ${id} and customers.status <> 'deactivated'
         order by customers.name
         limit 5
      `),
      db
        .select({ id: users.id })
        .from(appAccess)
        .innerJoin(users, eq(users.id, appAccess.userId))
        .where(and(eq(appAccess.app, "admin"), eq(appAccess.role, "admin"), eq(users.active, true))),
    ]);

    const blockers: string[] = [];
    if (id === me.id) blockers.push("You cannot deactivate your own account.");
    else if (grants.some((g) => g.app === "admin" && g.role === "admin") && !admins.some((a) => a.id !== id)) {
      blockers.push(`${person.name} is the only platform administrator, so their sign-in cannot be turned off.`);
    }

    const bookCount = Number(book[0]?.n ?? 0);
    const bookNames = book.map((b) => b.name);
    const items: ImpactItem[] = [
      {
        app: "Admin Console",
        label: Number(sessions?.n) === 1 ? "open sign-in" : "open sign-ins",
        effect: "deleted",
        count: Number(sessions?.n ?? 0),
        note: "Ended at once — a tab they have open stops working on its next click.",
      },
      {
        app: "MBOS handsets",
        label: Number(devices?.n) === 1 ? "phone bound to them" : "phones bound to them",
        effect: "phones",
        count: Number(devices?.n ?? 0),
        examples: devices?.models ? devices.models.split(", ").slice(0, 5) : undefined,
        note: "Its next sync is refused because the account is closed. Whatever is still in its outbox stays on the phone, unsent, until the account is enabled again.",
      },
      {
        app: "CRM",
        label: bookCount === 1 ? "customer in their book" : "customers in their book",
        effect: "kept",
        count: bookCount,
        examples: bookNames,
        note: "They stay in this person's book, so nobody else is chased to call them until the accounts are moved.",
      },
      {
        app: "MahekOne",
        label: grants.length === 1 ? "app they hold" : "apps they hold",
        effect: "kept",
        count: grants.length,
        examples: grants.slice(0, 5).map((g) => getApp(g.app)?.name ?? g.app),
        note: "Kept, so enabling them again restores what they had. Taking an app away is Manage access.",
      },
    ];
    return {
      title: person.name,
      verb: "Disable",
      confirmWord: typeable(person.name, "DISABLE"),
      items,
      blockers: person.active ? blockers : ["This sign-in is already disabled."],
    };
  },
};

/* --------------------------------------------------------- a key cleared */

type Felt = { app: string; label: string; note: string };

/**
 * What stops without each key — one sentence per credential, said here once
 * rather than by each console screen that draws the row.
 */
const STOPS: Record<SecretName, Felt> = {
  "sarvam.apiKey": {
    app: "CRM",
    label: "dictation's Indian-language hearing",
    note: "Recordings go to OpenAI where that is allowed; with neither, the microphone disappears from every box, in the CRM and on the handsets.",
  },
  "openai.apiKey": {
    app: "CRM",
    label: "dictation's writing — Tighten and Rewrite",
    note: "Tighten and Rewrite disappear from the dictation modal, and recordings over 30 seconds can no longer be heard.",
  },
  "anthropic.apiKey": {
    app: "Accounts",
    label: "the second, independent AI review of price changes",
    note: "Price changes are reviewed by OpenAI alone, and the screens say a second reviewer is not connected. Nothing about prices themselves changes.",
  },
  "msg91.authKey": { app: "MahekOne", label: "nothing", note: "Nothing uses it — WhatsApp goes through Wati." },
  "wati.apiToken": {
    app: "Founder",
    label: "WhatsApp sending through the API",
    note: "Nothing can go through the API until a key is set again; every screen falls back to copy and paste, and live automation rules stop sending. The webhook address changes with the next key.",
  },
  "minimoth.apiKey": {
    app: "MahekOne",
    label: "sign-in codes",
    note: "Sign-in codes stop being offered on the web and on the handset. Everybody signs in with their password.",
  },
  "olamaps.apiKey": {
    app: "Sales Dashboard",
    label: "street maps — the Live map and Territory's shop map",
    note: "Neither draws streets, and the Live map's trail goes back to a raw GPS line. Handsets cannot save new areas for offline use; what is already on a phone goes on working.",
  },
  "olamaps.apiKey2": spare(),
  "olamaps.apiKey3": spare(),
  "olamaps.apiKey4": spare(),
  "olamaps.apiKey5": spare(),
  "enquiries.ingestSecret": {
    app: "Website",
    label: "enquiries from mahekindia.com",
    note: "The website's enquiries stop arriving in Website Enquiries until a new one is set on both sides.",
  },
  "website.cmsReadSecret": {
    app: "Website",
    label: "mahekindia.com reading its content from here",
    note: "The public site can no longer read content or uploaded images from MahekOne and falls back to the content built into it.",
  },
  "website.cmsPublishSecret": {
    app: "Website",
    label: "publishing to the live site, and previews",
    note: "Publishing still saves here, but the live site is not told to refresh and preview links stop working.",
  },
};

/** Each credential as the console names it. */
const TITLE: Record<SecretName, string> = {
  "sarvam.apiKey": "the Sarvam key",
  "openai.apiKey": "the OpenAI key",
  "anthropic.apiKey": "the Anthropic key",
  "msg91.authKey": "the MSG91 key",
  "wati.apiToken": "the Wati key",
  "minimoth.apiKey": "the MiniMoth key",
  "olamaps.apiKey": "the Ola Maps key",
  "olamaps.apiKey2": "the second Ola Maps key",
  "olamaps.apiKey3": "the third Ola Maps key",
  "olamaps.apiKey4": "the fourth Ola Maps key",
  "olamaps.apiKey5": "the fifth Ola Maps key",
  "enquiries.ingestSecret": "the website enquiry ingest secret",
  "website.cmsReadSecret": "the website content read secret",
  "website.cmsPublishSecret": "the website publish secret",
};

function spare(): Felt {
  return {
    app: "Sales Dashboard",
    label: "a spare key in the Ola Maps pool",
    note: "The pool gets shorter. Nothing changes today unless the keys ahead of it have already run out — then the maps stop drawing streets the moment the last one does.",
  };
}

/** `admin-secret` — `clearSecretAction`. The id is the credential's name. A platform administrator's, as the act asks. */
export const secretImpact: ImpactSource = {
  async authorize() {
    const user = await requireUser();
    if (!(await isPlatformAdmin(user))) throw new Error("Only a platform admin can change credentials.");
    if (!(await isConsoleConfirmed())) throw new ConsoleNotConfirmedError();
  },
  async report(name) {
    if (!isSecretName(name)) return null;
    const [row] = await db.select({ last4: appSecrets.last4 }).from(appSecrets).where(eq(appSecrets.name, name));
    const env = SECRET_NAMES[name];
    const fromEnv = Boolean(process.env[env]?.trim());
    const felt = STOPS[name];
    const items: ImpactItem[] = [];
    if (row) {
      items.push({
        app: "Admin Console",
        label: "key saved here",
        effect: "deleted",
        count: 1,
        examples: [`••••${row.last4}`],
        note: "It cannot be recovered from here — a saved key is never read back, so putting it again means pasting it again.",
      });
      items.push(
        fromEnv
          ? {
              app: felt.app,
              label: felt.label,
              effect: "kept",
              count: 0,
              note: `${env} is set on this deployment, so that key takes over rather than the feature stopping.`,
            }
          : { app: felt.app, label: felt.label, effect: "changed", count: 1, note: felt.note },
      );
    } else {
      items.push({
        app: felt.app,
        label: felt.label,
        effect: "kept",
        count: 0,
        note: fromEnv ? `Nothing is saved here; ${env} on the deployment goes on being used.` : "Nothing is saved here to remove.",
      });
    }
    return { title: TITLE[name], verb: "Remove", confirmWord: "REMOVE", items, blockers: [] };
  },
};

/* -------------------------------------------------------- apps taken away */

/**
 * `admin-access-revoke` — the apps `setAccess` takes away in one save. The id
 * is `accessRevokeKey(user, apps)`: a save is the whole desired picture, and
 * what has to be confirmed is the part of it that takes something away.
 *
 * Each app takes its own furniture with it — module rows, the ERP's powers and
 * designation, HRMS's powers, the Hire role, the factory place — and the
 * Salesman App takes the phone: a handset is refused on its next sync.
 */
export const accessRevokeImpact: ImpactSource = {
  async authorize() {
    await requirePlatformAdminUser();
  },
  async report(id) {
    const parts = accessRevokeParts(id);
    if (!parts) return null;
    const { userId, apps } = parts;
    const [person] = await db.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, userId));
    if (!person || !apps.length) return null;
    const me = await requireUser();

    const held = await db.select({ app: appAccess.app, role: appAccess.role }).from(appAccess).where(eq(appAccess.userId, userId));
    const going = held.filter((h) => apps.includes(h.app));
    const staying = held.filter((h) => !apps.includes(h.app));
    const has = (app: string) => going.some((g) => g.app === app);
    const list = sql.join(apps.map((a) => sql`${a}`), sql`, `);

    const [[modules], [erpPowers], designation, [hrmsPowers], [hire], [floor], [phones], [sessions], admins] = await Promise.all([
      db.execute<{ n: number }>(sql`select count(*)::int as n from app_module_access where user_id = ${userId} and app::text in (${list})`),
      has("erp")
        ? db.execute<{ n: number }>(sql`select count(*)::int as n from erp_user_powers where user_id = ${userId}`)
        : Promise.resolve([{ n: 0 }]),
      has("erp")
        ? db.execute<{ name: string }>(sql`
            select d.name from erp_user_designations u join erp_designations d on d.id = u.designation_id where u.user_id = ${userId}
          `)
        : Promise.resolve([] as { name: string }[]),
      has("hrms")
        ? db.execute<{ n: number }>(sql`select count(*)::int as n from hrms_user_powers where user_id = ${userId}`)
        : Promise.resolve([{ n: 0 }]),
      has("hire")
        ? db.execute<{ role: string }>(sql`select role from hire_user_roles where user_id = ${userId}`)
        : Promise.resolve([] as { role: string }[]),
      has("factory")
        ? db.execute<{ n: number }>(sql`select count(*)::int as n from factory_staff where user_id = ${userId}`)
        : Promise.resolve([{ n: 0 }]),
      has("field")
        ? db.execute<{ n: number }>(sql`select count(*)::int as n from mbos_devices where user_id = ${userId} and active`)
        : Promise.resolve([{ n: 0 }]),
      db.execute<{ n: number }>(sql`select count(*)::int as n from sessions where user_id = ${userId}`),
      db
        .select({ id: users.id })
        .from(appAccess)
        .innerJoin(users, eq(users.id, appAccess.userId))
        .where(and(eq(appAccess.app, "admin"), eq(appAccess.role, "admin"), eq(users.active, true))),
    ]);

    const appName = (a: string) => getApp(a)?.name ?? a;
    const items: ImpactItem[] = [
      {
        app: "Admin Console",
        label: going.length === 1 ? "app taken away" : "apps taken away",
        effect: "deleted",
        count: going.length,
        examples: going.map((g) => `${appName(g.app)} (${g.role ?? "associate"})`),
        note: "Their screens refuse this person from the next click, and the launcher stops offering them.",
      },
      {
        app: "Admin Console",
        label: "screens they were narrowed to",
        effect: "deleted",
        count: Number(modules?.n ?? 0),
        note: "The narrowing goes with the app, so granting it back later opens it whole rather than to these screens.",
      },
      {
        app: "ERP",
        label: Number(erpPowers?.n) === 1 ? "ERP power" : "ERP powers",
        effect: "deleted",
        count: Number(erpPowers?.n ?? 0),
        note: "Seeing purchase money, approving and the rest go with the ERP.",
      },
      {
        app: "ERP",
        label: "designation",
        effect: "unlinked",
        count: designation.length,
        examples: designation.map((d) => d.name),
        note: "No longer theirs, so a later edit to the designation does not follow them.",
      },
      {
        app: "HRMS",
        label: Number(hrmsPowers?.n) === 1 ? "HRMS power" : "HRMS powers",
        effect: "deleted",
        count: Number(hrmsPowers?.n ?? 0),
      },
      {
        app: "Hire",
        label: "job inside Hire",
        effect: "deleted",
        count: hire ? 1 : 0,
        examples: hire ? [hire.role.replace(/_/g, " ")] : undefined,
        note: "Given Hire back, they start from their level rather than from this job.",
      },
      {
        app: "Factory",
        label: "place on the factory floor",
        effect: "deleted",
        count: Number(floor?.n ?? 0),
        note: "Their department, crew seat and badge go with the Factory app.",
      },
      {
        app: "MBOS handsets",
        label: Number(phones?.n) === 1 ? "phone bound to them" : "phones bound to them",
        effect: "phones",
        count: Number(phones?.n ?? 0),
        note: "Its next sync is refused — Mahek MBOS has been taken off the account. Whatever is still in its outbox stays on the phone, unsent.",
      },
      {
        app: "MahekOne",
        label: Number(sessions?.n) === 1 ? "open sign-in" : "open sign-ins",
        effect: "kept",
        count: Number(sessions?.n ?? 0),
        note: staying.length
          ? `They stay signed in, and keep ${staying.map((s) => appName(s.app)).join(", ")}.`
          : "They stay signed in, onto a launcher that says they hold nothing.",
      },
    ];

    const blockers: string[] = [];
    if (going.some((g) => g.app === "admin" && g.role === "admin")) {
      if (userId === me.id) blockers.push("You cannot take away your own administrator access. Another administrator has to.");
      else if (!admins.some((a) => a.id !== userId)) {
        blockers.push(`${person.name} is the only platform administrator. Make somebody else Admin on the Admin Console first.`);
      }
    }
    return {
      title: `${going.map((g) => appName(g.app)).join(", ") || "apps"} from ${person.name}`,
      verb: "Take away",
      confirmWord: typeable(person.name, "REVOKE"),
      items,
      blockers: going.length ? blockers : [`${person.name} holds none of these apps any more.`],
    };
  },
};
