import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { modulesForApp } from "@/lib/modules";
import { APP_IDS } from "@/lib/apps";
import { DOC_APPS, DOC_TABS, tabsOf } from "./registry";

/* ---------------------------------------------------------------------------
 * The Documentation app cannot drift silently from the product it describes.
 *
 * Four questions, each of which used to be "somebody would have to notice":
 * does every screen of a documented app have a page; does every tab marked
 * written have content; is every piece of content claimed by a page; and is
 * the build-time index — the code excerpts — cut from the source as it is
 * now. `content.ts` is read as TEXT because it imports MDX, which only the
 * bundler can load.
 * ------------------------------------------------------------------------- */

const DOCS = join(process.cwd(), "src/docs");
const CONTENT_SRC = readFileSync(join(DOCS, "content.ts"), "utf8");
const CONTENT_KEYS = new Set([...CONTENT_SRC.matchAll(/^\s*"([^"]+)":\s*\(\)\s*=>\s*import\("\.\/([^"]+)"\)/gm)].map((m) => m[1]));

function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name.startsWith("_") ? [] : mdxFiles(path);
    return name.endsWith(".mdx") ? [relative(DOCS, path).replace(/\.mdx$/, "")] : [];
  });
}

describe("documentation coverage", () => {
  test("every documented app is a real app, and section slugs are unique", () => {
    for (const a of DOC_APPS) if (a.appId) assert.ok((APP_IDS as readonly string[]).includes(a.appId), a.appId);
    assert.equal(new Set(DOC_APPS.map((a) => a.app)).size, DOC_APPS.length);
  });

  test("a page marks written only tabs it has", () => {
    for (const a of DOC_APPS)
      for (const p of a.pages)
        for (const t of p.written) assert.ok(tabsOf(p).includes(t), `${a.app}/${p.slug}: "${t}" is written but not one of its tabs`);
  });

  test("every module of a documented app is claimed by a page", () => {
    for (const a of DOC_APPS) {
      if (!a.appId) continue;
      const claimed = new Set(a.pages.flatMap((p) => p.modules));
      const missing = modulesForApp(a.appId).filter((m) => !claimed.has(m.key)).map((m) => m.key);
      assert.deepEqual(missing, [], `${a.app}: no documentation page claims ${missing.join(", ")}`);
    }
  });

  test("a page claims only modules that exist, and no module is claimed twice", () => {
    for (const a of DOC_APPS) {
      if (!a.appId) {
        for (const p of a.pages) assert.deepEqual(p.modules, [], `${a.app}/${p.slug}: a section with no app claims modules`);
        continue;
      }
      const real = new Set(modulesForApp(a.appId).map((m) => m.key));
      const seen = new Set<string>();
      for (const p of a.pages) {
        for (const k of p.modules) {
          assert.ok(real.has(k), `${a.app}/${p.slug} claims "${k}", which is not a module`);
          assert.ok(!seen.has(k), `"${k}" is claimed by two pages`);
          seen.add(k);
        }
      }
    }
  });

  test("slugs are unique and every page's group is one of its app's groups", () => {
    for (const a of DOC_APPS) {
      const slugs = a.pages.map((p) => p.slug);
      assert.equal(new Set(slugs).size, slugs.length, `${a.app}: duplicate slug`);
      for (const p of a.pages) assert.ok(a.groups.includes(p.group), `${a.app}/${p.slug}: unknown group "${p.group}"`);
    }
  });

  test("every tab marked written has content, a loader and an MDX file", () => {
    for (const a of DOC_APPS) {
      for (const p of a.pages) {
        for (const t of p.written) {
          const key = `${a.app}/${p.slug}/${t}`;
          assert.ok(CONTENT_KEYS.has(key), `${key} is marked written but content.ts has no loader for it`);
          assert.ok(existsSync(join(DOCS, `${key}.mdx`)), `${key}.mdx does not exist`);
        }
      }
    }
  });

  test("every MDX file and every loader belongs to a written tab", () => {
    const written = new Set(DOC_APPS.flatMap((a) => a.pages.flatMap((p) => p.written.map((t) => `${a.app}/${p.slug}/${t}`))));
    for (const f of mdxFiles(DOCS)) assert.ok(written.has(f), `${f}.mdx exists but no page marks that tab written`);
    for (const k of CONTENT_KEYS) assert.ok(written.has(k), `content.ts loads ${k}, which no page marks written`);
    for (const k of written) {
      assert.ok(DOC_TABS.some((t) => k.endsWith(`/${t.id}`)), `${k}: not a tab`);
    }
  });

  test("no diagram carries a semicolon, which Mermaid reads as the end of a statement", () => {
    /* Mermaid only runs in the browser, so a chart that fails to parse is
       found by whoever opens the page. The one mistake that has happened is
       a `;` in a label: it ends the statement, and the rest of the line is a
       syntax error. Cheap to forbid outright. */
    for (const f of mdxFiles(DOCS)) {
      const body = readFileSync(join(DOCS, `${f}.mdx`), "utf8");
      for (const [, chart] of body.matchAll(/<Flow\b[^>]*chart=\{`([\s\S]*?)`\}/g)) {
        assert.ok(!chart.includes(";"), `${f}.mdx: a <Flow> chart contains ";" — reword the label`);
      }
    }
  });

  test("every piece of code the documentation quotes still exists", () => {
    /* The index itself is built, never committed (it would go stale every
       time main moved). What CAN be wrong in a PR is a quoted function that
       was renamed or deleted — that fails here, naming the page. */
    const run = spawnSync(process.execPath, ["scripts/docs-index.mjs", "--verify"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  });
});
