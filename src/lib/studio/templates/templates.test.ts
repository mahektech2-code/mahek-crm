import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTemplateRegistry } from "./registry";
import { loadFontRegistry } from "../fonts";
import { loadTemplateFolder } from "./loader";
import { loadOccasions } from "./occasions";
import { readPngSize } from "./png";

const projectRoot = path.resolve(process.cwd(), "studio");
const realTemplates = path.join(projectRoot, "templates");
const realAssets = path.join(projectRoot, "assets");

let tmp: string;
let counter = 0;

// A scratch templates folder: a copy of one real template under a new id, plus the real occasions.
function scratch(): { dir: string; add: (id: string, from?: string) => string } {
  const dir = path.join(tmp, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(realTemplates, "occasions.json"), path.join(dir, "occasions.json"));
  return {
    dir,
    add(id, from = "diwali-classic") {
      const target = path.join(dir, id);
      fs.cpSync(path.join(realTemplates, from), target, { recursive: true });
      const file = path.join(target, "template.json");
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), id }, null, 2));
      return target;
    },
  };
}
const edit = (file: string, fn: (json: Record<string, unknown>) => void) => {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(json);
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
};
const registryFor = (dir: string) => createTemplateRegistry({ templatesDir: dir, assetsDir: realAssets });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-templates-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the real templates folder", () => {
  const registry = createTemplateRegistry({ templatesDir: realTemplates, assetsDir: realAssets });

  test("all eight approved templates load with no problems", () => {
    assert.deepEqual(registry.problems(), []);
    assert.equal(registry.list().length, 8);
  });
  test("templates are listed in calendar order, then by name", () => {
    const order = registry.list().map((t) => t.manifest.occasion);
    assert.deepEqual(order, ["dussehra", "diwali", "diwali", "newyear", "holi", "independence", "anytime", "anytime"]);
    assert.deepEqual(registry.list().filter((t) => t.manifest.occasion === "diwali").map((t) => t.manifest.id), ["diwali-classic", "diwali-premium"]);
  });
  test("get finds a template by id and returns null for an unknown one", () => {
    assert.equal(registry.get("diwali-premium")?.manifest.version, "1.3.0");
    assert.equal(registry.get("nope"), null);
  });
  test("occasions keep the file order and only occasions with a design are 'with templates'", () => {
    assert.deepEqual(registry.occasions().map((o) => o.id), ["dussehra", "diwali", "newyear", "holi", "independence", "anytime"]);
    assert.equal(registry.occasionsWithTemplates().length, 6);
  });
  test("every template's background is exactly its canvas size and its preview exists", () => {
    for (const t of registry.list()) {
      assert.deepEqual(readPngSize(fs.readFileSync(t.backgroundPath)), { width: t.manifest.canvas.width, height: t.manifest.canvas.height }, t.manifest.id);
      assert.ok(fs.existsSync(t.previewPath));
    }
  });
  test("every declared language has approved wording", () => {
    for (const t of registry.list()) for (const l of t.manifest.languages) assert.ok((t.copy[l]?.length ?? 0) > 0, `${t.manifest.id}/${l}`);
  });
  test("the font registry resolves every family to a real file", () => {
    const fonts = loadFontRegistry(realAssets);
    assert.deepEqual([...fonts.families.keys()].sort(), ["noto-sans", "noto-sans-devanagari", "noto-sans-gujarati"]);
  });
  test("the occasions file parses and uses date-only strings", () => {
    const occasions = loadOccasions(realTemplates);
    assert.equal(occasions.find((o) => o.id === "diwali")?.date, "2026-11-08");
    assert.equal(occasions.find((o) => o.id === "anytime")?.date, null);
  });
});

// A published version is immutable. When a design changes, the new look is published under a NEW version number and the previous
// version stays as an archived copy, so a creative made with it renders the same again.
describe("design versions: an earlier version of a design is kept as an archived copy", () => {
  const registry = createTemplateRegistry({ templatesDir: realTemplates, assetsDir: realAssets });
  // design id -> [earlier version (archived), current version]
  const VERSIONS: Record<string, [string, string]> = {
    "diwali-classic": ["1.0.1", "1.1.0"],
    "diwali-premium": ["1.2.0", "1.3.0"],
    "holi-colour": ["1.0.0", "1.1.0"],
    "independence-salute": ["1.0.0", "1.1.0"],
    "newyear-gold": ["1.1.0", "1.2.0"],
    "welcome-note": ["1.0.0", "1.1.0"],
  };

  test("the refreshed designs are published under new versions, and each earlier version is archived under its own id", () => {
    for (const [id, [earlier, current]] of Object.entries(VERSIONS)) {
      assert.equal(registry.get(id)?.manifest.version, current, id);
      const archived = registry.getVersion(id, earlier);
      assert.equal(archived?.manifest.id, `${id}-v${earlier.replaceAll(".", "-")}`);
      assert.equal(archived?.manifest.status, "archived");
      assert.equal(archived?.manifest.versionOf, id);
      assert.equal(archived?.manifest.version, earlier);
    }
    assert.equal(registry.archivedVersions().length, 6);
    assert.deepEqual(registry.problems(), []);
  });
  test("getVersion: no version or the current version is the current design; an earlier version is the archived copy; an unknown one is null", () => {
    assert.equal(registry.getVersion("diwali-premium"), registry.get("diwali-premium"));
    assert.equal(registry.getVersion("diwali-premium", "1.3.0"), registry.get("diwali-premium"));
    assert.equal(registry.getVersion("diwali-premium", "1.2.0")?.manifest.id, "diwali-premium-v1-2-0");
    assert.equal(registry.getVersion("diwali-premium", "9.9.9"), null);
    assert.equal(registry.getVersion("nope", "1.0.0"), null);
    assert.equal(registry.getVersion("dussehra-victory", "1.0.0"), registry.get("dussehra-victory")); // never changed: no archived copy needed
  });
  test("an archived copy is never listed and never a design of its own: new creatives cannot be made from it", () => {
    assert.equal(registry.get("diwali-premium-v1-2-0"), null);
    assert.equal(registry.list().some((t) => t.manifest.status !== "approved" || t.manifest.versionOf !== undefined), false);
    assert.equal(registry.list().length, 8);
  });
  test("an archived copy keeps the audiences, languages and wording it was published with", () => {
    const current = registry.get("welcome-note");
    const old = registry.getVersion("welcome-note", "1.0.0");
    assert.deepEqual(old?.manifest.languages, current?.manifest.languages);
    assert.deepEqual(old?.copy, current?.copy);
  });
  test("an archived copy with the same version as the current design is excluded and reported, not guessed at", () => {
    const s = scratch();
    s.add("diwali-premium", "diwali-premium");
    const same = s.add("diwali-premium-same", "diwali-premium-v1-2-0");
    edit(path.join(same, "template.json"), (j) => (j.version = "1.3.0"));
    const registry = registryFor(s.dir);
    assert.equal(registry.getVersion("diwali-premium", "1.3.0")?.manifest.id, "diwali-premium");
    assert.equal(registry.archivedVersions().length, 0);
    assert.match(registry.problems().map((p) => `${p.folder}: ${p.message}`).join("\n"), /diwali-premium-same: archived copy has the same version as the current/);
  });
  test("a second archived copy of the same version is excluded and reported", () => {
    const s = scratch();
    s.add("diwali-premium", "diwali-premium");
    s.add("diwali-premium-v1-2-0", "diwali-premium-v1-2-0");
    s.add("diwali-premium-v1-2-0-b", "diwali-premium-v1-2-0");
    const registry = registryFor(s.dir);
    assert.deepEqual(registry.archivedVersions().map((t) => t.manifest.id), ["diwali-premium-v1-2-0"]);
    assert.match(registry.problems().map((p) => `${p.folder}: ${p.message}`).join("\n"), /diwali-premium-v1-2-0-b: a second archived copy of diwali-premium@1\.2\.0/);
  });
});

describe("adding a template is content only", () => {
  test("a ninth template appears from a new folder alone, with no code change", () => {
    const s = scratch();
    for (const id of ["a-one", "b-two", "c-three", "d-four", "e-five", "f-six", "g-seven", "h-eight"]) s.add(id);
    assert.equal(registryFor(s.dir).list().length, 8);
    s.add("i-nine");
    const after = registryFor(s.dir);
    assert.equal(after.list().length, 9);
    assert.ok(after.get("i-nine"));
    assert.deepEqual(after.problems(), []);
  });
  test("a draft or archived template is loaded but not listed (only approved templates are renderable)", () => {
    const s = scratch();
    const dir = s.add("draft-one");
    edit(path.join(dir, "template.json"), (j) => (j.status = "draft"));
    const dir2 = s.add("archived-one");
    edit(path.join(dir2, "template.json"), (j) => (j.status = "archived"));
    s.add("live-one");
    const r = registryFor(s.dir);
    assert.deepEqual(r.list().map((t) => t.manifest.id), ["live-one"]);
    assert.equal(r.get("draft-one"), null);
    assert.deepEqual(r.problems(), []);
  });
});

describe("an invalid template is excluded and reported, never half-loaded", () => {
  const problemsOf = (mutate: (dir: string) => void, id = "bad-one") => {
    const s = scratch();
    s.add("good-one");
    mutate(s.add(id));
    const r = registryFor(s.dir);
    assert.deepEqual(r.list().map((t) => t.manifest.id), ["good-one"], "the good template is unaffected");
    return r.problems().filter((p) => p.folder === id).map((p) => p.message);
  };

  test("broken JSON", () => {
    const m = problemsOf((d) => fs.writeFileSync(path.join(d, "template.json"), "{ not json"));
    assert.ok(m.some((x) => /template\.json cannot be read/.test(x)), m.join("|"));
  });
  test("a schema violation names the field", () => {
    const m = problemsOf((d) => edit(path.join(d, "template.json"), (j) => ((j.fields as { box: object }[])[1].box = { x: 5000, y: 0, w: 10, h: 10 })));
    assert.ok(m.some((x) => /outside the 1080x1080 canvas/.test(x)), m.join("|"));
  });
  test("an id that does not match the folder name", () => {
    const m = problemsOf((d) => edit(path.join(d, "template.json"), (j) => (j.id = "something-else")));
    assert.ok(m.some((x) => /must equal the folder name/.test(x)), m.join("|"));
  });
  test("a missing background file", () => {
    const m = problemsOf((d) => fs.rmSync(path.join(d, "background.png")));
    assert.ok(m.some((x) => /background file .* is missing/.test(x)), m.join("|"));
  });
  test("a background that is not the canvas size", () => {
    const m = problemsOf((d) => edit(path.join(d, "template.json"), (j) => ((j.canvas as { width: number }).width = 2000)));
    assert.ok(m.some((x) => /background is 1080x1080 but the canvas is 2000x1080/.test(x)), m.join("|"));
  });
  test("a missing preview", () => {
    const m = problemsOf((d) => fs.rmSync(path.join(d, "preview.png")));
    assert.ok(m.some((x) => /preview\.png.* is missing/.test(x)), m.join("|"));
  });
  test("an occasion that is not in occasions.json", () => {
    const m = problemsOf((d) => edit(path.join(d, "template.json"), (j) => (j.occasion = "no-such-festival")));
    assert.ok(m.some((x) => /not in occasions\.json/.test(x)), m.join("|"));
  });
  test("a font family that does not exist, or that does not cover the language's script", () => {
    const unknown = problemsOf((d) => edit(path.join(d, "template.json"), (j) => ((j.fonts as Record<string, Record<string, string>>).display.hi = "no-such-font")));
    assert.ok(unknown.some((x) => /unknown font family "no-such-font"/.test(x)), unknown.join("|"));
    const wrongScript = problemsOf((d) => edit(path.join(d, "template.json"), (j) => ((j.fonts as Record<string, Record<string, string>>).display.hi = "noto-sans")));
    assert.ok(wrongScript.some((x) => /does not cover the devanagari script/.test(x)), wrongScript.join("|"));
  });
  test("copy.json missing a declared language", () => {
    const m = problemsOf((d) => edit(path.join(d, "copy.json"), (j) => delete j.hi));
    assert.ok(m.some((x) => /no wording for declared language "hi"/.test(x)), m.join("|"));
  });
  test("copy.json wording that breaks a guardrail (digits, claims, bad placeholder, too long)", () => {
    const m = problemsOf((d) =>
      edit(path.join(d, "copy.json"), (j) => {
        (j.en as { text: string }[])[0].text = "Get 20 off with {unknown}! " + "x".repeat(400);
      }),
    );
    const all = m.join("|");
    assert.ok(/digits/.test(all) && /placeholder/.test(all) && /characters; the limit is/.test(all), all);
  });
  test("copy.json wording for a language the template does not declare", () => {
    const m = problemsOf((d) => edit(path.join(d, "copy.json"), (j) => (j.gu = [{ id: "formal", label: "Professional", text: "નમસ્તે {company}" }])));
    assert.ok(m.some((x) => /does not declare/.test(x)), m.join("|"));
  });
  test("a missing logo asset", () => {
    const s = scratch();
    s.add("only-one");
    const emptyAssets = path.join(tmp, `assets-${counter++}`);
    fs.cpSync(realAssets, emptyAssets, { recursive: true });
    fs.rmSync(path.join(emptyAssets, "logos"), { recursive: true });
    const r = createTemplateRegistry({ templatesDir: s.dir, assetsDir: emptyAssets });
    assert.equal(r.list().length, 0);
    assert.ok(r.problems().some((p) => /logo variant .* is missing/.test(p.message)));
  });
  test("loadTemplateFolder on a valid folder returns the template and no problems", () => {
    const s = scratch();
    const dir = s.add("fine-one");
    const fonts = loadFontRegistry(realAssets);
    const result = loadTemplateFolder(dir, { templatesDir: s.dir, assetsDir: realAssets, fonts, occasions: loadOccasions(s.dir) });
    assert.ok(result.template);
    assert.deepEqual(result.problems, []);
  });
});

describe("png header reader", () => {
  test("reads the size, and rejects things that are not PNG files", () => {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(1080, 16);
    header.writeUInt32BE(720, 20);
    assert.deepEqual(readPngSize(header), { width: 1080, height: 720 });
    assert.equal(readPngSize(Buffer.from("not a png at all, just text")), null);
    assert.equal(readPngSize(Buffer.alloc(4)), null);
  });
});
