import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CANVAS_PRESETS, buildManifest, canvasById, canvasForSize, checkPlacement, copyFromDraft, declaredLanguages, defaultPlacement, newTemplateId, nextVersion, normalizeDraft, parsePlacement, type PlacementDraft } from "./template-upload";

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

describe("languages on an uploaded design", () => {
  const meta = { id: "custom-lang-test", version: "1.0.0", status: "approved" as const, approvedBy: "T", approvedAt: "2026-11-13" };
  /** A design with a greeting and a fixed headline, in English plus the languages asked for, each complete. */
  function multi(languages: ("hi" | "gu")[]): PlacementDraft {
    const d = draft(["company_name", "greeting", "occasion_title"]);
    d.fields.find((f) => f.key === "occasion_title")!.text = "Season's Greetings";
    const i18n: NonNullable<PlacementDraft["i18n"]> = {};
    if (languages.includes("hi")) i18n.hi = { messages: ["आपके और आपकी टीम के लिए एक सफल मौसम की शुभकामनाएँ।"], statics: { occasion_title: "शुभकामनाएँ" } };
    if (languages.includes("gu")) i18n.gu = { messages: ["તમને અને તમારી ટીમને સફળ મોસમની શુભેચ્છાઓ."], statics: { occasion_title: "શુભેચ્છાઓ" } };
    return { ...draft(["company_name", "greeting", "occasion_title"]), fields: d.fields, languages, i18n };
  }

  test("a design with no languages is English only, which is every design uploaded before languages existed", () => {
    assert.deepEqual(declaredLanguages({}), ["en"]);
    assert.deepEqual(declaredLanguages({ languages: [] }), ["en"]);
    const built = buildManifest(draft(), meta);
    assert.ok(built.ok);
    if (built.ok) assert.deepEqual(built.manifest.languages, ["en"]);
  });

  test("English plus Hindi plus Gujarati: declared in a fixed order, each drawn in its own script's font, each with its own copy", () => {
    const d = multi(["gu", "hi"]);
    assert.deepEqual(declaredLanguages(d), ["en", "hi", "gu"]);
    assert.deepEqual(checkPlacement(d).errors, []);
    const built = buildManifest(d, meta);
    assert.ok(built.ok, built.ok ? "" : built.problems.join("; "));
    if (!built.ok) return;
    assert.deepEqual(built.manifest.languages, ["en", "hi", "gu"]);
    assert.deepEqual(built.manifest.fonts.body, { en: "noto-sans", hi: "noto-sans-devanagari", gu: "noto-sans-gujarati" });
    const headline = built.manifest.fields.find((f) => f.key === "occasion_title");
    assert.ok(headline && headline.type === "text");
    if (headline && headline.type === "text") assert.deepEqual(headline.text, { en: "Season's Greetings", hi: "शुभकामनाएँ", gu: "શુભેચ્છાઓ" });
    const copy = copyFromDraft(d);
    assert.deepEqual(Object.keys(copy), ["en", "hi", "gu"]);
    assert.match(copy.hi![0]!.text, /शुभकामनाएँ/);
    assert.match(copy.gu![0]!.text, /શુભેચ્છાઓ/);
  });

  test("a declared language with anything missing is never publishable", () => {
    const noMessages = multi(["hi"]);
    noMessages.i18n!.hi!.messages = [];
    assert.match(checkPlacement(noMessages).errors.map((e) => e.message).join(" "), /message in हिन्दी/);
    const noHeadline = multi(["gu"]);
    noHeadline.i18n!.gu!.statics = {};
    assert.match(checkPlacement(noHeadline).errors.map((e) => e.message).join(" "), /ગુજરાતી: the fixed text cannot be empty|in ગુજરાતી/);
    const noContent = { ...multi(["hi"]), i18n: undefined };
    assert.ok(checkPlacement(noContent).errors.length >= 2, "no Hindi content at all is refused, never filled in from English");
  });

  test("the wording must be in the language's own script, and never in the other Indic script", () => {
    const latinHindi = multi(["hi"]);
    latinHindi.i18n!.hi!.messages = ["Wishing you a bright season."];
    assert.match(checkPlacement(latinHindi).errors.map((e) => e.message).join(" "), /Devanagari/);
    const gujaratiInHindi = multi(["hi"]);
    gujaratiInHindi.i18n!.hi!.messages = ["તમને શુભેચ્છાઓ."];
    assert.ok(checkPlacement(gujaratiInHindi).errors.length > 0);
    const gujaratiHeadlineInHindi = multi(["hi"]);
    gujaratiHeadlineInHindi.i18n!.hi!.statics = { occasion_title: "શુભેચ્છાઓ" };
    assert.match(checkPlacement(gujaratiHeadlineInHindi).errors.map((e) => e.message).join(" "), /script/);
  });

  test("wording rules apply in every language: no digits, links, prices or claims", () => {
    for (const bad of ["आपको 50% छूट मिलेगी।", "देखें www.example.com पर।"]) {
      const d = multi(["hi"]);
      d.i18n!.hi!.messages = [bad];
      assert.ok(checkPlacement(d).errors.length > 0, bad);
    }
  });

  test("a stored placement is read back: the old English-only shape and the new one both parse; unknown keys do not", () => {
    assert.ok(parsePlacement(draft()).ok, "old shape");
    assert.ok(parsePlacement(multi(["hi", "gu"])).ok, "new shape");
    assert.equal(parsePlacement({ ...multi(["hi"]), languages: ["fr"] }).ok, false, "only Hindi and Gujarati can be added");
    assert.equal(parsePlacement({ ...multi(["hi"]), i18n: { hi: { messages: [], statics: {}, extra: 1 } } }).ok, false);
    assert.equal(parsePlacement({ ...multi(["hi"]), i18n: { mr: { messages: [], statics: {} } } }).ok, false);
  });
});

describe("the loader's wording rules are applied before publishing, in every language", () => {
  const withMessages = (messages: string[]): PlacementDraft => ({ ...draft(["company_name", "greeting"]), messages });
  test("English wording the registry would reject is refused here: digits, prices, links, claims and new-lead language", () => {
    for (const bad of ["Get 20 cans free this week.", "Visit www.example.com today.", "Best price guaranteed for you.", "Welcome to Mahek, thanks for your interest.", "Wishing you 100% success."]) {
      assert.ok(checkPlacement(withMessages([bad])).errors.length > 0, bad);
    }
    assert.deepEqual(checkPlacement(withMessages(["Wishing you a bright season ahead."])).errors, []);
  });
  test("a lead-style line in Hindi or Gujarati is refused too", () => {
    const hi: PlacementDraft = { ...withMessages(["Wishing you a bright season ahead."]), languages: ["hi"], i18n: { hi: { messages: ["हमारे साथ आपकी रुचि के लिए धन्यवाद।"], statics: {} } } };
    assert.ok(checkPlacement(hi).errors.some((e) => /new-lead/.test(e.message)));
    const gu: PlacementDraft = { ...withMessages(["Wishing you a bright season ahead."]), languages: ["gu"], i18n: { gu: { messages: ["અમારા પરિવારમાં આપનું સ્વાગત છે."], statics: {} } } };
    assert.ok(checkPlacement(gu).errors.some((e) => /new-lead/.test(e.message)));
  });
});

describe("normalizeDraft and nextVersion", () => {
  const base = (): PlacementDraft => draft(["company_name", "greeting", "occasion_title"]);
  test("an English-only design is stored exactly as it always was", () => {
    const d = { ...base(), languages: [] as ("hi" | "gu")[], i18n: { hi: { messages: ["x"], statics: {} } } };
    const n = normalizeDraft(d);
    assert.equal("languages" in n, false);
    assert.equal("i18n" in n, false);
    assert.deepEqual(Object.keys(n).sort(), ["canvas", "fields", "messages", "name", "occasion"]);
  });
  test("languages come out in their fixed order, once each; undeclared content and unplaced fixed text are dropped", () => {
    const d: PlacementDraft = {
      ...base(),
      languages: ["gu", "hi", "gu"],
      i18n: { hi: { messages: ["एक"], statics: { occasion_title: "शुभ", eyebrow: "stray" } }, gu: { messages: ["એક"], statics: { occasion_title: "શુભ" } } },
    };
    const n = normalizeDraft(d);
    assert.deepEqual(n.languages, ["hi", "gu"]);
    assert.deepEqual(n.i18n!.hi!.statics, { occasion_title: "शुभ" }, "the placed headline is kept, the unplaced eyebrow is not");
    const gone = normalizeDraft({ ...d, languages: ["hi"] });
    assert.deepEqual(Object.keys(gone.i18n ?? {}), ["hi"]);
  });
  test("messages are kept only where a message field is placed", () => {
    const d: PlacementDraft = { ...draft(["company_name"]), languages: ["hi"], i18n: { hi: { messages: ["शुभकामनाएँ"], statics: {} } } };
    assert.deepEqual(normalizeDraft(d).i18n!.hi!.messages, []);
  });
  test("a missing language entry becomes an empty one, never a gap", () => {
    assert.deepEqual(normalizeDraft({ ...base(), languages: ["hi"] }).i18n, { hi: { messages: [], statics: {} } });
  });
  test("the number of fixed texts per language is capped when a placement is read", () => {
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, "x"]));
    assert.equal(parsePlacement({ ...base(), languages: ["hi"], i18n: { hi: { messages: [], statics: many } } }).ok, false);
    const ok = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, "x"]));
    assert.equal(parsePlacement({ ...base(), languages: ["hi"], i18n: { hi: { messages: [], statics: ok } } }).ok, true);
  });
  test("the next version raises the patch number, and anything unreadable starts again at 1.0.1", () => {
    assert.equal(nextVersion("1.0.0"), "1.0.1");
    assert.equal(nextVersion("1.2.9"), "1.2.10");
    assert.equal(nextVersion("2.0.0"), "2.0.1");
    assert.equal(nextVersion("banana"), "1.0.1");
  });
});
