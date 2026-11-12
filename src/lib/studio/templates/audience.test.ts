import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wordingForAudience } from "@/lib/studio/domain/template-audience";
import { createTemplateRegistry } from "./registry";

// The template audience policy (CUSTOMER_FEATURE_BLUEPRINT.md section 7.2), proved against the real
// templates folder and against scratch copies.

const projectRoot = path.resolve(process.cwd(), "studio");
const realTemplates = path.join(projectRoot, "templates");
const realAssets = path.join(projectRoot, "assets");

let tmp: string;
let counter = 0;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-audience-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function scratch() {
  const dir = path.join(tmp, `case-${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(realTemplates, "occasions.json"), path.join(dir, "occasions.json"));
  return {
    dir,
    /** A copy of a real template under a new id, with its manifest and wording edited by the caller. */
    add(id: string, edit: (manifest: Record<string, unknown>, copy: Record<string, { id: string; label: string; text: string; audiences?: string[] }[]>) => void = () => {}, from = "diwali-classic") {
      const target = path.join(dir, id);
      fs.cpSync(path.join(realTemplates, from), target, { recursive: true });
      const mf = path.join(target, "template.json");
      const cf = path.join(target, "copy.json");
      const manifest = { ...JSON.parse(fs.readFileSync(mf, "utf8")), id };
      const copy = JSON.parse(fs.readFileSync(cf, "utf8"));
      edit(manifest, copy);
      fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
      fs.writeFileSync(cf, JSON.stringify(copy, null, 2));
    },
  };
}
const registryFor = (dir: string) => createTemplateRegistry({ templatesDir: dir, assetsDir: realAssets });
const problemsFor = (dir: string, id: string) =>
  registryFor(dir)
    .problems()
    .filter((p) => p.folder === id)
    .map((p) => p.message);

describe("the real templates", () => {
  const registry = createTemplateRegistry({ templatesDir: realTemplates, assetsDir: realAssets });
  const snapshot = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "lead-offering.snapshot.json"), "utf8")) as {
    occasions: string[];
    designs: { id: string; occasion: string; category: string; requires: string[]; languages: string[]; wording: Record<string, string[]> }[];
  };

  test("REGRESSION: leads are offered exactly what they were offered before the audience migration", () => {
    const now = registry.list({ audience: "lead" }).map((t) => ({
      id: t.manifest.id,
      occasion: t.manifest.occasion,
      category: t.manifest.category,
      requires: t.manifest.requires,
      languages: registry.languagesFor(t, "lead"),
      wording: Object.fromEntries(registry.languagesFor(t, "lead").map((l) => [l, wordingForAudience(t.manifest, t.copy[l] ?? [], "lead").map((o) => o.id)])),
    }));
    assert.deepEqual(now, snapshot.designs);
    assert.deepEqual(registry.occasionsWithTemplates("lead").map((o) => o.id), snapshot.occasions);
  });
  test("leads are also offered what the unfiltered list offers: no template was taken away from them", () => {
    assert.deepEqual(registry.list({ audience: "lead" }).map((t) => t.manifest.id), registry.list().map((t) => t.manifest.id));
  });
  test("every template declares its audiences explicitly: none relies on the compatibility default", () => {
    for (const t of registry.list()) {
      assert.ok(Array.isArray(t.manifest.audiences) && t.manifest.audiences.length > 0, t.manifest.id);
      assert.deepEqual(t.warnings ?? [], [], t.manifest.id);
    }
  });
  test("welcome-note stays lead-only and is never offered to a customer", () => {
    assert.deepEqual(registry.get("welcome-note")?.manifest.audiences, ["lead"]);
    assert.ok(registry.list({ audience: "lead" }).some((t) => t.manifest.id === "welcome-note"));
    assert.ok(!registry.list({ audience: "customer" }).some((t) => t.manifest.id === "welcome-note"));
  });
  test("the festival designs and product-spotlight are shared", () => {
    for (const id of ["diwali-classic", "diwali-premium", "dussehra-victory", "holi-colour", "independence-salute", "newyear-gold", "product-spotlight"]) {
      assert.deepEqual(registry.get(id)?.manifest.audiences, ["lead", "customer"], id);
    }
    assert.deepEqual(registry.list({ audience: "customer" }).map((t) => t.manifest.id).sort(), ["diwali-classic", "diwali-premium", "dussehra-victory", "holi-colour", "independence-salute", "newyear-gold", "product-spotlight"]);
  });
  test("no real design is customer-only yet, so customers never see a design leads cannot", () => {
    for (const t of registry.list({ audience: "customer" })) assert.ok(registry.list({ audience: "lead" }).some((l) => l.manifest.id === t.manifest.id), t.manifest.id);
  });
  test("every offered language has wording cleared for that audience", () => {
    for (const kind of ["lead", "customer"] as const) {
      for (const t of registry.list({ audience: kind })) {
        for (const lang of registry.languagesFor(t, kind)) assert.ok(wordingForAudience(t.manifest, t.copy[lang] ?? [], kind).length > 0, `${t.manifest.id}/${lang}/${kind}`);
      }
    }
  });
});

describe("the policy on scratch templates", () => {
  test("a customer-only relationship design loads, is offered to customers only, and its occasion chip follows the audience", () => {
    const s = scratch();
    s.add("keep-lead"); // shared festival design
    s.add("thanks-only", (m) => {
      m.category = "relationship";
      m.audiences = ["customer"];
      m.occasion = "anytime";
    });
    const r = registryFor(s.dir);
    assert.deepEqual(r.problems(), []);
    assert.deepEqual(r.list({ audience: "customer" }).map((t) => t.manifest.id).sort(), ["keep-lead", "thanks-only"]);
    assert.deepEqual(r.list({ audience: "lead" }).map((t) => t.manifest.id), ["keep-lead"]);
    assert.ok(r.occasionsWithTemplates("customer").some((o) => o.id === "anytime"));
    assert.ok(!r.occasionsWithTemplates("lead").some((o) => o.id === "anytime"));
    assert.ok(r.languagesFor(r.get("thanks-only")!, "lead").length === 0, "a customer-only design offers leads no language");
  });
  test("a manifest with no audiences loads, is read as lead-only, and carries a warning", () => {
    const s = scratch();
    s.add("legacy-one", (m) => {
      delete m.audiences;
    });
    const r = registryFor(s.dir);
    assert.deepEqual(r.problems(), []);
    assert.ok(r.list({ audience: "lead" }).some((t) => t.manifest.id === "legacy-one"));
    assert.ok(!r.list({ audience: "customer" }).some((t) => t.manifest.id === "legacy-one"), "a missing field is NEVER read as shared");
    assert.ok((r.get("legacy-one")?.warnings ?? []).some((w) => /no "audiences"/.test(w)));
  });
  test("category rules: greeting is lead-only; relationship and repeat are customer-only", () => {
    const s = scratch();
    s.add("greet-both", (m) => {
      m.category = "greeting";
      m.audiences = ["lead", "customer"];
    });
    s.add("greet-customer", (m) => {
      m.category = "greeting";
      m.audiences = ["customer"];
    });
    s.add("thanks-both", (m) => {
      m.category = "relationship";
      m.audiences = ["lead", "customer"];
    });
    s.add("thanks-undeclared", (m) => {
      m.category = "relationship";
      delete m.audiences;
    });
    s.add("repeat-lead", (m) => {
      m.category = "repeat";
      m.audiences = ["lead"];
    });
    for (const id of ["greet-both", "greet-customer", "thanks-both", "thanks-undeclared", "repeat-lead"]) {
      assert.ok(problemsFor(s.dir, id).some((m) => /audiences/.test(m)), id);
    }
    assert.deepEqual(registryFor(s.dir).list(), []);
  });
  test("audiences must be a non-empty list of known kinds without duplicates", () => {
    const s = scratch();
    s.add("empty-one", (m) => (m.audiences = []));
    s.add("dup-one", (m) => (m.audiences = ["lead", "lead"]));
    s.add("odd-one", (m) => (m.audiences = ["supplier"]));
    for (const id of ["empty-one", "dup-one", "odd-one"]) assert.ok(problemsFor(s.dir, id).length > 0, id);
  });
  test("a wording line can narrow the audiences, and the languages offered follow the wording that is cleared", () => {
    const s = scratch();
    s.add("narrow-one", (_m, copy) => {
      for (const o of copy.hi) o.audiences = ["lead"]; // Hindi wording not yet cleared for customers
    });
    const r = registryFor(s.dir);
    assert.deepEqual(r.problems(), []);
    const t = r.get("narrow-one")!;
    assert.deepEqual(r.languagesFor(t, "lead"), ["en", "hi"]);
    assert.deepEqual(r.languagesFor(t, "customer"), ["en"], "customers are offered only the language that is cleared for them");
    assert.deepEqual(wordingForAudience(t.manifest, t.copy.hi ?? [], "customer"), []);
    assert.ok(wordingForAudience(t.manifest, t.copy.en ?? [], "customer").length > 0);
  });
  test("a wording line cannot widen the audiences of its design", () => {
    const s = scratch();
    s.add("widen-one", (m, copy) => {
      m.audiences = ["lead"];
      copy.en[0].audiences = ["lead", "customer"];
    });
    assert.ok(problemsFor(s.dir, "widen-one").some((m) => /audience "customer" is not one of the design's audiences/.test(m)));
  });
  test("wording that reads like a lead welcome is refused for customers, and accepted once it is lead-only", () => {
    const s = scratch();
    s.add("leady-shared", (_m, copy) => {
      copy.en[0].text = "Thank you for your interest in Mahek. We look forward to working with {company}.";
    });
    s.add("leady-narrowed", (_m, copy) => {
      copy.en[0].text = "Thank you for your interest in Mahek. We look forward to working with {company}.";
      copy.en[0].audiences = ["lead"];
    });
    assert.ok(problemsFor(s.dir, "leady-shared").some((m) => /new-lead welcome or enquiry/.test(m)));
    assert.deepEqual(problemsFor(s.dir, "leady-narrowed"), []);
  });
  test("lead-style Hindi and Gujarati words are caught too", () => {
    const s = scratch();
    s.add("hindi-leady", (_m, copy) => {
      copy.hi[0].text = "{company} में आपकी रुचि के लिए धन्यवाद।";
    });
    assert.ok(problemsFor(s.dir, "hindi-leady").some((m) => /new-lead welcome/.test(m)));
  });
});
