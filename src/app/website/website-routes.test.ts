import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_MODULES, moduleAllowed } from "@/lib/modules";

/* ---------------------------------------------------------------------------
 * The Website app's route guards and its prototype wording.
 *
 * What a person may open is the module grant, and the grant is only worth
 * anything if every route checks it: the sidebar hiding a link is a courtesy.
 * The browser run covers the behaviour end to end; this file is the part that
 * runs on every commit and fails the day somebody adds a screen without a
 * guard, or a toast that claims something was saved.
 *
 * File-reading rather than rendering, for the reason `layout-rules.test.ts`
 * is: the guards are server components that redirect, and nothing here has a
 * request to run them in.
 * ------------------------------------------------------------------------- */

const DIR = join(process.cwd(), "src", "app", "website");
const read = (p: string) => readFileSync(join(DIR, p), "utf8");

const websiteModules = APP_MODULES.filter((m) => m.app === "website");
const slugOf = (key: string) => key.replace(/^website\./, "");

describe("the Website module registry", () => {
  it("has exactly the 12 screens, dashboard first", () => {
    assert.deepEqual(
      websiteModules.map((m) => slugOf(m.key)),
      ["dashboard", "products", "industries", "pages", "gallery", "media", "careers", "testimonials", "milestones", "navigation", "seo", "settings"],
    );
  });
  it("every module points at a route that exists", () => {
    for (const m of websiteModules) {
      const slug = slugOf(m.key);
      const file = slug === "dashboard" ? "page.tsx" : join(slug, "page.tsx");
      assert.ok(existsSync(join(DIR, file)), `${m.key} → ${m.href} has no ${file}`);
      assert.equal(m.href, slug === "dashboard" ? "/website" : `/website/${slug}`, m.key);
    }
  });
  it("the sidebar offers exactly the registered screens", () => {
    const shell = read("website-shell.tsx");
    const hrefs = [...shell.matchAll(/href: "(\/website[^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual([...hrefs].sort(), websiteModules.map((m) => m.href).sort());
  });
});

describe("every Website route enforces its own module grant", () => {
  for (const m of websiteModules) {
    const slug = slugOf(m.key);
    it(`${m.key} is guarded on the server`, () => {
      const file = slug === "dashboard" ? "page.tsx" : join(slug, "layout.tsx");
      assert.ok(existsSync(join(DIR, file)), `${m.key} has no ${file}`);
      const src = read(file);
      assert.ok(
        src.includes(`requireWebsiteModule("${slug}")`),
        `${file} must call requireWebsiteModule("${slug}") — a hidden link is not a guard`,
      );
      // The guard is awaited, so a redirect actually happens before anything renders.
      assert.match(src, new RegExp(`await requireWebsiteModule\\("${slug}"\\)`));
    });
  }

  it("the guard asks for the module key of the slug it is given", () => {
    const src = read("require-module.ts");
    assert.match(src, /requireModule\(user\.id, `website\.\$\{slug\}`\)/);
  });

  it("no module folder is left without a layout", () => {
    const folders = readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const f of folders) {
      assert.ok(existsSync(join(DIR, f, "layout.tsx")), `src/app/website/${f} has no layout.tsx guard`);
      assert.ok(websiteModules.some((m) => slugOf(m.key) === f), `${f} is not a registered Website module`);
    }
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
  it("a grant with no module rows still opens all 12 (existing grants do not narrow)", () => {
    for (const m of websiteModules) assert.equal(moduleAllowed(m.key, [], "website"), true, m.key);
  });
  it("a grant of one other module opens only that one", () => {
    for (const m of websiteModules) assert.equal(moduleAllowed(m.key, ["website.seo"], "website"), m.key === "website.seo", m.key);
  });
});

describe("the dashboard shows only what the grant opens", () => {
  it("filters its tiles and counts by the same grant the route guards read", () => {
    const src = read("page.tsx");
    assert.match(src, /listUserModules\(user\.id, "website"\)/);
    assert.match(src, /TILES\.filter\(\(t\) => allowed\.has\(t\.href\)\)/);
    assert.match(src, /\.filter\(\(m\) => allowed\.has\(m\.href\)\)/);
  });
});

describe("the prototype is announced and never claims to have saved", () => {
  it("the app layout draws the notice above every screen", () => {
    const layout = read("layout.tsx");
    assert.match(layout, /<PrototypeNotice \/>/);
    const notice = read("prototype-notice.tsx");
    assert.match(notice, /PROTOTYPE_NOTE/);
    assert.match(notice, /Nothing here is saved to a\s+database or published to the live website/);
  });

  const screens = readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(d.name, "page.tsx"));

  it("every success toast goes through tempFeedback()", () => {
    for (const f of screens) {
      const src = read(f);
      // A plain string handed to toast.push is a success message with no note;
      // only the error tone (a second argument) may be plain.
      for (const m of src.matchAll(/toast\.push\(([^;]*)\);/g)) {
        const arg = m[1];
        if (/"error"\s*$/.test(arg.trim())) continue;
        assert.match(arg, /tempFeedback\(/, `${f}: toast.push(${arg}) must use tempFeedback()`);
      }
    }
  });

  it("no toast or message says something was saved, uploaded, posted or published", () => {
    for (const f of screens) {
      const src = read(f);
      for (const m of src.matchAll(/tempFeedback\(([^)]*)\)/g)) {
        assert.doesNotMatch(m[1], /\b(saved to|uploaded|posted|published)\b/i, `${f}: ${m[1]}`);
      }
      assert.doesNotMatch(src, /"Settings saved\.?"|"SEO metadata saved\.?"|"Photo uploaded\.?"|"Job posted\.?"/, f);
    }
  });
});
