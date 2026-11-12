import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CANVAS_PRESETS, buildManifest, canvasById, canvasForSize, checkPlacement, copyFromDraft, defaultPlacement, newTemplateId, parsePlacement, type PlacementDraft } from "./template-upload";

const canvas = canvasById("square")!;
function draft(keys: ("company_name" | "customer_name" | "product_name" | "greeting" | "contact_phone" | "logo" | "occasion_title")[] = ["company_name"]): PlacementDraft {
  const fields: PlacementDraft["fields"] = [];
  let y = 40;
  for (const key of keys) {
    const f = { ...defaultPlacement(key, canvas, []), y };
    fields.push(f);
    y += f.h + 40;
  }
  return { name: "Test design", canvas: "square", occasion: "anytime", fields, messages: keys.includes("greeting") ? ["Wishing you a bright season ahead."] : [] };
}

describe("canvas sizes", () => {
  test("three standard shapes are recognised; any other shape becomes 1080 wide at its own proportions", () => {
    assert.deepEqual(CANVAS_PRESETS.map((c) => `${c.width}x${c.height}`), ["1080x1080", "1080x1350", "1080x1920"]);
    assert.equal(canvasForSize(2160, 2160)?.id, "square");
    assert.equal(canvasForSize(1080, 1350)?.id, "portrait");
    assert.equal(canvasForSize(720, 1280)?.id, "story");
    const a4 = canvasForSize(1055, 1491)!;
    assert.deepEqual([a4.id, a4.width, a4.height], ["c1080x1526", 1080, 1526]);
    assert.deepEqual([canvasForSize(1200, 800)?.width, canvasForSize(1200, 800)?.height], [1080, 720]);
    assert.equal(canvasForSize(4000, 600), null, "too wide");
    assert.equal(canvasForSize(500, 2000), null, "too tall");
    assert.equal(canvasForSize(0, 0), null);
    assert.equal(canvasById("c1080x1526")?.height, 1526);
    assert.equal(canvasById("c500x500"), null);
    assert.equal(canvasById("c1080x9999"), null);
  });
});

describe("checkPlacement", () => {
  test("a valid placement has no errors", () => assert.deepEqual(checkPlacement(draft(["company_name", "customer_name", "product_name"])).errors, []));
  test("nothing placed, or only fixed text, is refused: every poster would be identical", () => {
    assert.ok(checkPlacement({ ...draft(), fields: [] }).errors.length > 0);
    assert.match(checkPlacement(draft(["occasion_title"])).errors.map((e) => e.message).join(" "), /personalized/);
  });
  test("a box outside the canvas, or too small, is refused", () => {
    const d = draft();
    d.fields[0]!.x = 900;
    assert.match(checkPlacement(d).errors[0]!.message, /outside/);
    const s = draft();
    s.fields[0]!.w = 20;
    assert.match(checkPlacement(s).errors.map((e) => e.message).join(" "), /too small/);
  });
  test("overlapping fields are refused", () => {
    const d = draft(["company_name", "customer_name"]);
    d.fields[1]!.y = d.fields[0]!.y + 10;
    assert.match(checkPlacement(d).errors.map((e) => e.message).join(" "), /overlaps/);
  });
  test("a box too short for one line at the smallest size is refused", () => {
    const d = draft();
    d.fields[0]!.h = 40;
    d.fields[0]!.minSize = 60;
    d.fields[0]!.size = 60;
    assert.match(checkPlacement(d).errors.map((e) => e.message).join(" "), /too short/);
  });
  test("the same field twice, a bad colour and a bad size are refused", () => {
    const d = draft(["company_name"]);
    d.fields.push({ ...d.fields[0]!, y: 500 });
    assert.match(checkPlacement(d).errors.map((e) => e.message).join(" "), /twice/);
    const c = draft();
    c.fields[0]!.color = "red";
    assert.match(checkPlacement(c).errors.map((e) => e.message).join(" "), /colour/);
    const z = draft();
    z.fields[0]!.size = 5;
    assert.match(checkPlacement(z).errors.map((e) => e.message).join(" "), /font size/);
  });
  test("a message field needs approved, checked messages", () => {
    const d = draft(["company_name", "greeting"]);
    d.messages = [];
    assert.match(checkPlacement(d).errors.map((e) => e.message).join(" "), /at least one approved/);
    d.messages = ["Get 50% off today at https://example.com"];
    assert.ok(checkPlacement(d).errors.length > 0);
  });
  test("a fixed line must be plain text", () => {
    const d = draft(["company_name", "occasion_title"]);
    d.fields[1]!.text = "Call https://evil.example";
    assert.ok(checkPlacement(d).errors.length > 0);
  });
});

describe("manifest", () => {
  const meta = { id: "custom-test-design-ab12cd34", version: "1.0.0", status: "approved" as const, approvedBy: "11111111-1111-4111-8111-111111111111", approvedAt: "2026-10-23" };
  test("a placement becomes a valid template manifest in the built-in format", () => {
    const built = buildManifest(draft(["company_name", "customer_name", "product_name", "greeting", "contact_phone", "logo"]), meta);
    assert.ok(built.ok, built.ok ? "" : built.problems.join("; "));
    if (!built.ok) return;
    const m = built.manifest;
    assert.equal(m.canvas.width, 1080);
    assert.deepEqual(m.languages, ["en"]);
    assert.equal(m.fields.find((f) => f.key === "product_name")?.type === "text" && (m.fields.find((f) => f.key === "product_name") as { source: string }).source, "poster");
    assert.equal((m.fields.find((f) => f.key === "company_name") as { crmPath: string }).crmPath, "lead.company");
  });
  test("every canvas size builds", () => {
    for (const c of CANVAS_PRESETS) {
      const d: PlacementDraft = { ...draft(), canvas: c.id };
      assert.ok(buildManifest(d, meta).ok, c.id);
    }
  });
  test("ids are kebab-case, unique per call input and never a built-in id", () => {
    assert.match(newTemplateId("Diwali Special!", "AB12CD34ZZ"), /^custom-diwali-special-ab12cd34$/);
    assert.match(newTemplateId("!!!", "ab12cd34"), /^custom-ab12cd34$/);
  });
  test("copy comes from the entered messages only when a message field exists", () => {
    assert.deepEqual(copyFromDraft(draft()), {});
    assert.equal(copyFromDraft(draft(["company_name", "greeting"])).en?.[0]?.text, "Wishing you a bright season ahead.");
  });
});

describe("untrusted placement", () => {
  test("unknown keys and out-of-range values are refused", () => {
    assert.ok(parsePlacement(draft()).ok);
    assert.equal(parsePlacement({ ...draft(), extra: 1 }).ok, false);
    assert.equal(parsePlacement({ ...draft(), canvas: "huge" }).ok, false);
    const d = draft();
    (d.fields[0] as unknown as Record<string, unknown>).key = "password";
    assert.equal(parsePlacement(d).ok, false);
    assert.equal(parsePlacement("nope").ok, false);
  });
});

describe("manual product name", () => {
  test("a typed product name is checked like other poster text and kept off the CRM", async () => {
    const { parsePersonalization } = await import("./personalization");
    const good = parsePersonalization({ product: "Mahek Sugar 50 kg" });
    assert.ok(good.ok && good.data.product === "Mahek Sugar 50 kg");
    for (const bad of ["Buy now at 50% off", "https://x.example", "Call 9876543210", "x".repeat(61), "<b>x</b>"]) assert.equal(parsePersonalization({ product: bad }).ok, false, bad);
  });
  test("a poster-source product field takes the typed value and nothing from the CRM", async () => {
    const { resolveFieldValues } = await import("./fields");
    const lead = { id: "l", contact: "A", company: "B", city: null, state: null, product: { id: "p", code: "X1", name: "CRM Product" }, source: "s", addedAt: "2026-01-01", ownerId: "u", ownerName: "U" } as never;
    const user = { id: "u", name: "U", role: "r", initials: "U" } as never;
    const field = { type: "text" as const, key: "product_name", source: "poster" as const };
    const typed = resolveFieldValues({ fields: [field], lead, user, language: "en", greeting: null, showOptional: true, poster: { product: "Typed Product" } });
    assert.deepEqual(typed.values.product_name, { kind: "text", text: "Typed Product" });
    const none = resolveFieldValues({ fields: [field], lead, user, language: "en", greeting: null, showOptional: true });
    assert.equal(none.values.product_name, null, "never falls back to the CRM product");
  });
});
