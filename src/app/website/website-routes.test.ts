import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_MODULES, moduleAllowed } from "@/lib/modules";

/* ---------------------------------------------------------------------------
 * The Website app's route guards and server surface.
 *
 * What a person may open is the module grant, and the grant is only worth
 * anything if every route checks it: the sidebar hiding a link is a courtesy.
 * The integration suite (`website-cms.test.ts`) proves what the server REFUSES;
 * this file runs on every commit and fails the day somebody adds a screen
 * without a guard, an action that skips the permission layer, or a public route
 * that forgets the secret.
 *
 * File-reading rather than rendering, for the reason `layout-rules.test.ts` is:
 * the guards are server components that redirect, and nothing here has a request
 * to run them in. The 12-by-12 runtime check is the browser run in the PR.
 * ------------------------------------------------------------------------- */

const ROOT = process.cwd();
const DIR = join(ROOT, "src", "app", "website");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const websiteModules = APP_MODULES.filter((m) => m.app === "website");
const screens = websiteModules.filter((m) => !m.writeOf);
const slugOf = (key: string) => key.replace(/^website\./, "");

describe("the Website module registry", () => {
  it("has the 12 screens, dashboard first, and one separate publishing right", () => {
    assert.deepEqual(
      screens.map((m) => slugOf(m.key)),
      ["dashboard", "products", "industries", "pages", "gallery", "media", "careers", "testimonials", "milestones", "navigation", "seo", "settings"],
    );
    assert.deepEqual(websiteModules.filter((m) => m.writeOf).map((m) => m.key), ["website.publish"]);
  });
  it("every screen points at a route that exists", () => {
    for (const m of screens) {
      const slug = slugOf(m.key);
      const file = slug === "dashboard" ? "page.tsx" : join(slug, "page.tsx");
      assert.ok(existsSync(join(DIR, file)), `${m.key} → ${m.href} has no ${file}`);
      assert.equal(m.href, slug === "dashboard" ? "/website" : `/website/${slug}`, m.key);
    }
  });
  it("the sidebar offers exactly the registered screens", () => {
    const hrefs = [...read("src", "app", "website", "website-shell.tsx").matchAll(/href: "(\/website[^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual([...hrefs].sort(), screens.map((m) => m.href).sort());
  });
});

describe("every Website route enforces its own module grant", () => {
  for (const m of screens) {
    const slug = slugOf(m.key);
    it(`${m.key} is guarded on the server`, () => {
      const file = slug === "dashboard" ? "page.tsx" : join(slug, "layout.tsx");
      assert.ok(existsSync(join(DIR, file)), `${m.key} has no ${file}`);
      const src = readFileSync(join(DIR, file), "utf8");
      assert.match(src, new RegExp(`await requireWebsiteModule\\("${slug}"\\)`), `${file} must await requireWebsiteModule("${slug}") — a hidden link is not a guard`);
    });
  }
  it("the guard asks for the module key of the slug it is given", () => {
    assert.match(read("src", "app", "website", "require-module.ts"), /requireModule\(user\.id, `website\.\$\{slug\}`\)/);
  });
  it("no module folder is left without a layout guard", () => {
    const folders = readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "cms-ui")
      .map((d) => d.name);
    for (const f of folders) {
      assert.ok(existsSync(join(DIR, f, "layout.tsx")), `src/app/website/${f} has no layout.tsx guard`);
      assert.ok(screens.some((m) => slugOf(m.key) === f), `${f} is not a registered Website module`);
    }
  });
  it("the shared redirect never sends somebody to a write right as if it were a screen", () => {
    assert.match(read("src", "lib", "access.ts"), /allowed\.find\(\(m\) => !m\.writeOf\)/);
  });
});

describe("what a narrowed grant opens", () => {
  const granted = ["website.dashboard", "website.products"];
  for (const m of websiteModules) {
    const expected = granted.includes(m.key);
    it(`${m.key}: ${expected ? "open" : "closed"} to a Dashboard + Products grant`, () => {
      assert.equal(moduleAllowed(m.key, granted, "website"), expected);
    });
  }
  it("a grant with no module rows opens all 12 screens but not the right to publish", () => {
    for (const m of screens) assert.equal(moduleAllowed(m.key, [], "website"), true, m.key);
    assert.equal(moduleAllowed("website.publish", [], "website"), false);
    assert.equal(moduleAllowed("website.publish", [], "website", true), false, "not even for an administrator");
  });
});

describe("the dashboard shows only what the grant opens", () => {
  it("filters its module cards by the same grant the route guards read", () => {
    const src = read("src", "app", "website", "page.tsx");
    assert.match(src, /listUserModules\(user\.id, "website"\)/);
    assert.match(src, /MODULES\.filter\(\(m\) => allowed\.has\(`\/website\/\$\{m\.slug\}`\)\)/);
  });
});

describe("the server surface cannot skip the permission layer", () => {
  it("every server action goes through a command, never straight to the service or the database", () => {
    const src = read("src", "lib", "actions", "website-cms.ts");
    assert.doesNotMatch(src, /@\/db/);
    assert.doesNotMatch(src, /\b(createItem|updateItem|transitionItems|deleteDraft|importWebsiteContent)\(/);
    const fns = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    assert.ok(fns.length >= 15, "the actions exist");
    for (const name of fns) {
      const body = src.slice(src.indexOf(`export async function ${name}`)).split(/\nexport async function /)[0];
      assert.match(body, /cms\./, `${name} must call a command`);
    }
  });
  it("every command asks who is asking before it does anything", () => {
    const src = read("src", "lib", "website-cms", "commands.ts");
    const fns = [...src.matchAll(/export function (\w+)\(/g)].map((m) => m[1]);
    assert.ok(fns.length >= 15);
    for (const name of fns) {
      const body = src.slice(src.indexOf(`export function ${name}(`)).split(/\nexport function /)[0];
      assert.match(body, /gate(Edit|AnyEdit|Publish)\(/, `${name} must check a gate`);
    }
  });
  it("both public routes check the secret before reading anything, and fail closed", () => {
    for (const route of ["content/route.ts", "media/[id]/route.ts"]) {
      const src = read("src", "app", "api", "public", "website", ...route.split("/"));
      assert.match(src, /readSecret\("website\.cmsReadSecret"\)/);
      assert.match(src, /status: 503/);
      assert.match(src, /bearerMatches\(request, secret\)/);
      const check = src.indexOf("bearerMatches(request, secret)");
      const reads = [src.indexOf("await currentBundle"), src.indexOf("await readMedia")].filter((i) => i >= 0);
      for (const r of reads) assert.ok(check < r, `${route} reads before it checks the secret`);
    }
  });
  it("the editor's upload and thumbnail routes require a signed-in person with a Website module", () => {
    for (const f of ["media/route.ts", "media/[id]/route.ts"]) {
      const src = read("src", "app", "api", "website", ...f.split("/"));
      assert.match(src, /getCurrentUser\(\)/);
      assert.match(src, /canEditAny\(user\.id\)/);
    }
  });
  it("the layout tells people while the live site is not connected, and nothing claims a prototype any more", () => {
    assert.match(read("src", "app", "website", "layout.tsx"), /<ConnectionNotice \/>/);
    for (const gone of ["mock-data.ts", "prototype.ts", "prototype-notice.tsx"]) assert.equal(existsSync(join(DIR, gone)), false, gone);
  });
});
