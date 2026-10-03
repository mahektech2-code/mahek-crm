import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ADMIN, ADMIN_GROUPS, ADMIN_PINNED, ADMIN_TABS } from "./admin-routes";
import { ADMIN_REDIRECTS } from "./admin-redirects";
import { SETTINGS_PAGES } from "./config/settings-pages";
import { schemaForPage } from "./config/settings-schemas";

/* ---------------------------------------------------------------------------
 * EVERY CONSOLE ADDRESS OPENS A PAGE.
 *
 * The console's links used to be a section and a tab named as loose strings,
 * and four of them pointed at screens that had moved — a "contracts" tab that
 * was deleted, a "sheet" section that was always "order-sheet", HRMS's link to
 * `/admin/access`, which was a blank page. None of it failed anywhere; the
 * screen was simply wrong. These resolve every address `ADMIN` can build, and
 * every redirect's destination, against the `page.tsx` files on disk.
 * ------------------------------------------------------------------------- */

const ROOT = "src/app/admin";

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pages(full));
    else if (entry === "page.tsx") out.push(dir);
  }
  return out;
}

/** Each page folder as a pattern over a path: `[[...tab]]` is optional segments, `[id]` one. */
const PATTERNS = pages(ROOT).map((dir) => {
  const segs = relative(ROOT, dir).split("/").filter(Boolean).filter((s) => !s.startsWith("_"));
  const body = segs
    .map((s) =>
      s.startsWith("[[...") ? "(?:/[^/]+)*" : s.startsWith("[...") ? "(?:/[^/]+)+" : s.startsWith("[") ? "/[^/]+" : `/${s}`,
    )
    .join("");
  return new RegExp(`^/admin${body}$`);
});

const resolves = (href: string) => {
  const path = href.split(/[?#]/)[0];
  return PATTERNS.some((p) => p.test(path));
};

test("every address the console builds has a page behind it", () => {
  const hrefs = [
    ADMIN.home,
    ADMIN.access,
    ADMIN.person("u_1"),
    ADMIN.person("u_1", "sessions"),
    ADMIN.settings,
    ADMIN.deletedLeads,
    ADMIN.integrations,
    ADMIN.handsets,
    ADMIN.jobs,
    ADMIN.notifications,
    ADMIN.database,
    ADMIN.components,
    ...ADMIN_TABS.feedback.map((t) => ADMIN.feedback(t.slug)),
    ...ADMIN_TABS.signIns.map((t) => ADMIN.signIns(t.slug)),
    ...ADMIN_TABS.catalogue.map((t) => ADMIN.catalogue(t.slug)),
    ...ADMIN_TABS.expensePolicy.map((t) => ADMIN.expensePolicy(t.slug)),
    ...ADMIN_TABS.sheets.map((t) => ADMIN.sheets(t.slug)),
    ...ADMIN_TABS.audit.map((t) => ADMIN.audit(t.slug)),
    ...SETTINGS_PAGES.flatMap((p) => schemaForPage(p.id)!.tabs.map((t) => ADMIN.settingsFor(p.id, t.key))),
    ...ADMIN_PINNED.map((i) => i.href),
    ...ADMIN_GROUPS.flatMap((g) => g.items.map((i) => i.href)),
  ];
  const dead = hrefs.filter((h) => !resolves(h));
  assert.deepEqual(dead, []);
});

test("every old address redirects to a page that exists, and settings tabs that exist", () => {
  const dead = ADMIN_REDIRECTS.map((r) => r.destination.replace(/:\w+[*+]?/g, "x"))
    .filter((d) => !resolves(d));
  assert.deepEqual(dead, []);

  // A redirect that names a settings tab must name one that is drawn.
  for (const r of ADMIN_REDIRECTS) {
    const m = r.destination.match(/^\/admin\/settings\/([^/]+)(?:\/([^/:]+))?$/);
    if (!m) continue;
    const schema = schemaForPage(m[1]);
    assert.ok(schema, `${r.source} → ${r.destination}: no such settings page`);
    if (m[2]) assert.ok(schema.tabs.some((t) => t.key === m[2]), `${r.source} → ${r.destination}: no such tab`);
  }
});

test("no redirect shadows a page that exists", () => {
  // A redirect is applied before the filesystem, so one whose source IS a page
  // would make that page unreachable.
  const shadowing = ADMIN_REDIRECTS.filter((r) => !/:/.test(r.source) && resolves(r.source)).map((r) => r.source);
  assert.deepEqual(shadowing, []);
});

test("nothing outside the route list spells a console address out", () => {
  // Built from `ADMIN` instead, so a renamed screen is a compile error rather
  // than a link that quietly lands somewhere else.
  const allowed = new Set([
    "src/lib/admin-routes.ts",
    "src/lib/admin-redirects.ts",
    "src/lib/admin-routes.test.ts",
  ]);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !allowed.has(full) && existsSync(full)) {
        const source = readFileSync(full, "utf8");
        for (const m of source.matchAll(/["'`]\/admin\/[a-z][^"'`]*["'`]/g)) offenders.push(`${full}: ${m[0]}`);
      }
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});
