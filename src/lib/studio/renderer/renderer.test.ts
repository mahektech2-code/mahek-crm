import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import sharp from "sharp";
import { createTemplateRegistry } from "../templates/registry";
import { fontDescription, registerFonts } from "./fonts";
import { candidateSizes, fitText, graphemes, type FitField } from "./text-fit";
import { drawLine, escapeMarkup, inkWidth, normalizeForRender, scriptClass } from "./text-layer";
import { parseColor } from "./color";
import { MAX_JPEG_BYTES, MAX_PNG_BYTES } from "./output";
import { isRenderError, renderCreative, type RenderInput, type RenderValue } from "./index";

const root = path.resolve(process.cwd(), "studio");
const registry = createTemplateRegistry({ templatesDir: path.join(root, "templates"), assetsDir: path.join(root, "assets") });
const tpl = registry.get("diwali-premium")!;
const logo = path.join(root, "assets", "logos", "mahek-light.png");

const textValues = (over: Record<string, RenderValue | null> = {}): Record<string, RenderValue | null> => ({
  logo: { assetPath: logo },
  occasion_title: { text: "Happy Diwali" },
  customer_name: { text: "Dear Rajesh Shah" },
  company_name: { text: "ABC Industries" },
  greeting: { text: "Wishing you and your team at ABC Industries a prosperous and joyful Diwali." },
  product_line: { text: "M1433 Thinner" },
  footer_site: { text: "mahekindia.com" },
  salesperson: { text: "Your Mahek contact · Priya Sharma" },
  ...over,
});
const input = (over: Partial<RenderInput> = {}, values = textValues()): RenderInput => ({
  template: { manifest: tpl.manifest, dir: tpl.dir, backgroundPath: tpl.backgroundPath },
  values,
  language: "en",
  fonts: registry.fonts.families,
  ...over,
});

before(async () => {
  await registerFonts(registry.fonts.families);
});

describe("text helpers", () => {
  test("escapeMarkup escapes exactly & < >", () => {
    assert.equal(escapeMarkup(`a&b<c>d "q" 'r'`), `a&amp;b&lt;c&gt;d "q" 'r'`);
  });
  test("normalizeForRender: NFC, line breaks become spaces, ZWJ and ZWNJ survive", () => {
    assert.equal(normalizeForRender("Cafe\u{301}\nBar"), "Café Bar");
    assert.equal(normalizeForRender("क्\u{200C}ष"), "क्\u{200C}ष");
    assert.equal(normalizeForRender("क्\u{200D}ष"), "क्\u{200D}ष");
  });
  test("scriptClass picks the script whose line metrics apply", () => {
    assert.equal(scriptClass("Hello & Co."), "latin");
    assert.equal(scriptClass("प्रिय Rajesh"), "devanagari");
    assert.equal(scriptClass("પ્રિય Rajesh"), "gujarati");
  });
  test("parseColor reads hex, short hex, hex with alpha, rgb() and rgba()", () => {
    assert.deepEqual(parseColor("#f8db92"), { hex: "#F8DB92", alpha: 1 });
    assert.deepEqual(parseColor("#fff"), { hex: "#FFFFFF", alpha: 1 });
    assert.equal(parseColor("#ffffff80").alpha.toFixed(2), "0.50");
    assert.deepEqual(parseColor("rgb(255, 0, 0)"), { hex: "#FF0000", alpha: 1 });
    assert.deepEqual(parseColor("rgba(248,219,146,0.16)"), { hex: "#F8DB92", alpha: 0.16 });
    assert.throws(() => parseColor("red"));
  });
  test("candidateSizes goes down by the step and always ends at minFont", () => {
    assert.deepEqual(candidateSizes(40, 28, 4), [40, 36, 32, 28]);
    assert.deepEqual(candidateSizes(40, 27, 4), [40, 36, 32, 28, 27]);
    assert.deepEqual(candidateSizes(20, 20, 2), [20]);
  });
  test("graphemes keep Indic conjuncts whole", () => {
    assert.deepEqual(graphemes("क्षत्र"), ["क्ष", "त्र"]);
  });
});

describe("text fitting with the real fonts", () => {
  const field = (over: Partial<FitField> = {}): FitField => ({ key: "greeting", boxW: 840, boxH: 156, maxFont: 38, minFont: 22, step: 2, maxLines: 3, lh: 1.28, overflow: "ellipsis", ...over });
  const style = (lang: "en" | "hi" | "gu" = "en", role: "body" | "display" = "body", weight = 500) => {
    const description = fontDescription(tpl.manifest, role, lang, weight, registry.fonts.families);
    return (size: number) => ({ description, size });
  };

  test("short text keeps the largest size", async () => {
    const r = await fitText("Happy Diwali", field({ boxW: 940, boxH: 210, maxFont: 128, minFont: 56, step: 4, maxLines: 1, lh: 1.05 }), style("en", "display", 400));
    assert.equal(r.status, "fits");
    assert.equal(r.size, 128);
    assert.deepEqual(r.lines, ["Happy Diwali"]);
  });

  test("longer text shrinks and wraps, within the width, height and line limit", async () => {
    const text = "May the lights of Diwali bring happiness, good health and success to you, your family, your friends and everyone at Maharashtra Industrial Coatings and all of its branches across the country.";
    const f = field();
    const s = style();
    const r = await fitText(text, f, s);
    assert.equal(r.status, "auto-sized");
    assert.ok(r.size < 38 && r.size >= 22);
    assert.ok(r.lines.length <= 3 && r.lines.length * r.size * 1.28 <= 156.5);
    for (const line of r.lines) assert.ok((await inkWidth(line, s(r.size))) <= 840, line);
    assert.equal(r.lines.join(" "), text, "wrapping only breaks at spaces and loses nothing");
  });

  test("an over-long single word is shrunk (never split) while a smaller size still fits it", async () => {
    const word = "Pneumonoultramicroscopicsilicovolcanoconiosis";
    const f = field({ boxW: 500, maxLines: 1, boxH: 80, maxFont: 56, minFont: 20, lh: 1.1 });
    const r = await fitText(word, f, style("en", "body", 700));
    assert.deepEqual(r.lines, [word]);
    assert.ok(r.size < 56);
    assert.ok((await inkWidth(word, style("en", "body", 700)(r.size))) <= 500);
  });

  test("ellipsis: text that cannot fit even at minFont is cut on a grapheme boundary and ends with …", async () => {
    for (const [lang, text] of [
      ["hi", "क्षत्रज्ञश्र ".repeat(40)],
      ["gu", "ત્રક્ષજ્ઞ શ્રેષ્ઠ ".repeat(40)],
      ["hi", "सहकाऱ्यांना और ABC Industries ".repeat(30)],
    ] as const) {
      const s = style(lang);
      const r = await fitText(text, field(), s);
      assert.equal(r.status, "shortened");
      assert.equal(r.size, 22);
      assert.ok(r.lines.length <= 3);
      const joined = r.lines.join(" ");
      assert.ok(joined.endsWith("…"));
      for (const line of r.lines) assert.ok((await inkWidth(line, s(22))) <= 840);
      const kept = graphemes(joined.slice(0, -1).trimEnd());
      assert.deepEqual(kept, graphemes(text.normalize("NFC")).slice(0, kept.length), "an exact grapheme prefix of the original");
      assert.ok(!/^[\u{900}-\u{903}\u{93A}-\u{94F}\u{A81}-\u{A83}\u{ABE}-\u{ACD}]/u.test(kept.at(-1)!), "never ends on a lone dependent mark");
    }
  });

  test("block policy throws FieldOverflow", async () => {
    await assert.rejects(fitText("word ".repeat(200), field({ overflow: "block" }), style()), (e: unknown) => isRenderError(e) && e.code === "FieldOverflow" && e.subject === "greeting");
  });

  test("abbreviate policy uses the short form when the full text cannot fit", async () => {
    const r = await fitText("Maharashtra Industrial Coatings & Allied Products Pvt. Ltd.", field({ boxW: 300, maxLines: 1, boxH: 60, maxFont: 40, minFont: 30, lh: 1.1, overflow: "abbreviate" }), style("en", "body", 700), "MIC Pvt. Ltd.");
    assert.deepEqual(r.lines, ["MIC Pvt. Ltd."]);
    assert.equal(r.status, "shortened");
  });

  test("a box too small to show anything fails loudly instead of drawing wrongly", async () => {
    await assert.rejects(fitText("Hello", field({ boxW: 3, maxLines: 1, boxH: 60, maxFont: 40, minFont: 30 }), style()), (e: unknown) => isRenderError(e) && e.code === "FieldOverflow");
  });

  test("deterministic: the same input fits the same way twice", async () => {
    const t = "Wishing you and your team a prosperous and joyful Diwali full of light and happiness for everyone.";
    assert.deepEqual(await fitText(t, field(), style()), await fitText(t, field(), style()));
  });
});

describe("baseline stability (the Phase 0 baseline-jitter fix)", () => {
  // Place every string with the SAME target baseline, exactly as the renderer does, then find where
  // the flat bottom of its leading "H" really landed. Different glyphs below the baseline (g, y),
  // above it (É) or Indic marks must not move it.
  async function hBottomFor(text: string, size: number, lang: "en" | "hi" | "gu"): Promise<number> {
    const description = fontDescription(tpl.manifest, "body", lang, 700, registry.fonts.families);
    const layer = await drawLine(text, { description, size }, "#FFFFFF");
    assert.ok(layer);
    const target = 500;
    const top = Math.round(target - layer.baseline);
    let lowest = -1;
    for (let y = 0; y < layer.height; y++) {
      for (let x = 0; x < Math.max(3, Math.round(size * 0.12)); x++) if (layer.data[(y * layer.width + x) * 4 + 3] > 128) lowest = y;
    }
    return top + lowest + 1;
  }

  test("Latin strings with and without descenders and accents share one baseline", async () => {
    for (const size of [24, 38, 56]) {
      const rows = await Promise.all(["H", "Hx", "Hgy", "Hjp", "HÉÅ", "Hello World"].map((t) => hBottomFor(t, size, "en")));
      assert.ok(Math.max(...rows) - Math.min(...rows) <= 1, `size ${size}: ${rows.join(",")}`);
    }
  });
  test("lines containing Devanagari or Gujarati share one baseline per script", async () => {
    for (const size of [30, 48]) {
      const dev = await Promise.all(["Hक", "Hकुँ", "Hशुभ", "Hप्रिय Rajesh"].map((t) => hBottomFor(t, size, "hi")));
      assert.ok(Math.max(...dev) - Math.min(...dev) <= 1, `devanagari ${size}: ${dev.join(",")}`);
      const guj = await Promise.all(["Hક", "Hકિરણ", "Hશ્રી"].map((t) => hBottomFor(t, size, "gu")));
      assert.ok(Math.max(...guj) - Math.min(...guj) <= 1, `gujarati ${size}: ${guj.join(",")}`);
    }
  });
  test("the strut is invisible: a line of spaces draws nothing and real text has no stray pixels above it", async () => {
    const description = fontDescription(tpl.manifest, "body", "en", 400, registry.fonts.families);
    assert.equal(await drawLine("   ", { description, size: 40 }, "#FFFFFF"), null);
    const layer = await drawLine("ab", { description, size: 40 }, "#FFFFFF");
    assert.ok(layer && layer.height < 40, `cropped to the ink: ${layer?.height}`);
  });
});

describe("renderCreative", () => {
  test("PNG: 1080 x 1080, valid, within the size limit, with a complete report", async () => {
    const r = await renderCreative(input());
    const meta = await sharp(r.image).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["png", 1080, 1080]);
    assert.ok(r.image.length < MAX_PNG_BYTES);
    assert.equal(r.report.length, 8);
    assert.deepEqual(r.report.find((x) => x.key === "greeting")?.status, "fits");
    assert.equal(r.report.find((x) => x.key === "logo")?.status, "placed");
  });

  test("JPEG is valid and within its limit", async () => {
    const r = await renderCreative(input({ format: "jpeg" }));
    const meta = await sharp(r.image).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(r.image.length <= MAX_JPEG_BYTES);
  });

  test("deterministic: identical input gives identical bytes", async () => {
    const [a, b] = [await renderCreative(input()), await renderCreative(input())];
    assert.ok(a.image.equals(b.image));
  });

  test("special characters in names render literally and do not break markup", async () => {
    for (const name of ["Qureshi Hardware & Paints", "O'Brien & Co. <Paints> \"Best\"", "A<B>C <b>not bold</b>", "&amp; &lt;"]) {
      const r = await renderCreative(input({}, textValues({ company_name: { text: name } })));
      const row = r.report.find((x) => x.key === "company_name");
      assert.ok(row && row.status !== "skipped", name);
      assert.ok(row.text?.replaceAll("\n", " ").startsWith(name.slice(0, 8)), name);
    }
  });

  test("Hindi, Gujarati and mixed Latin + Indic text render", async () => {
    const hi = await renderCreative(input({ language: "hi" }, textValues({ occasion_title: { text: "शुभ दीपावली" }, customer_name: { text: "प्रिय Rajesh Shah" }, greeting: { text: "आपको और M1433 Thinner की टीम को क्ष त्र ज्ञ शुभकामनाएँ।" } })));
    assert.equal(hi.report.find((x) => x.key === "greeting")?.status !== "skipped", true);
    const gu = await renderCreative(input({ language: "gu" }, textValues({ occasion_title: { text: "દિવાળીની શુભેચ્છાઓ" }, customer_name: { text: "પ્રિય Kiran Patel" } })));
    assert.equal((await sharp(gu.image).metadata()).width, 1080);
  });

  test("an optional field with no value is skipped; a required one is a ValueMissing error", async () => {
    const skipped = await renderCreative(input({}, textValues({ product_line: null })));
    assert.equal(skipped.report.find((x) => x.key === "product_line")?.status, "skipped");
    await assert.rejects(renderCreative(input({}, textValues({ customer_name: null }))), (e: unknown) => isRenderError(e) && e.code === "ValueMissing" && e.subject === "customer_name");
  });

  test("a language the template does not offer is UnsupportedLanguage", async () => {
    await assert.rejects(renderCreative(input({ language: "mr" })), (e: unknown) => isRenderError(e) && e.code === "UnsupportedLanguage");
  });

  test("missing, relative or remote assets are AssetMissing, not a half-drawn image", async () => {
    for (const bad of [path.join(root, "assets", "logos", "nope.png"), "relative/logo.png", "https://example.com/logo.png"]) {
      await assert.rejects(renderCreative(input({}, textValues({ logo: { assetPath: bad } }))), (e: unknown) => isRenderError(e) && e.code === "AssetMissing", bad);
    }
  });

  test("an unknown font family is FontMissing", async () => {
    const broken = new Map([...registry.fonts.families].filter(([id]) => id !== "noto-sans-devanagari"));
    await assert.rejects(renderCreative(input({ language: "hi", fonts: broken }, textValues())), (e: unknown) => isRenderError(e) && e.code === "FontMissing");
  });

  test("a value of the wrong kind is TemplateInvalid", async () => {
    await assert.rejects(renderCreative(input({}, textValues({ logo: { text: "not an image" } }))), (e: unknown) => isRenderError(e) && e.code === "TemplateInvalid");
  });

  test("a field that cannot fit under a 'block' policy stops the render", async () => {
    const manifest = structuredClone(tpl.manifest);
    for (const f of manifest.fields) if (f.type === "text" && f.key === "company_name") f.overflow = "block";
    await assert.rejects(
      renderCreative({ ...input(), template: { manifest, dir: tpl.dir, backgroundPath: tpl.backgroundPath }, values: textValues({ company_name: { text: "Maharashtra Industrial Coatings & Allied Products Pvt. Ltd. ".repeat(8) } }) }),
      (e: unknown) => isRenderError(e) && e.code === "FieldOverflow",
    );
  });

  test("a background that is not the canvas size is TemplateInvalid", async () => {
    const manifest = structuredClone(tpl.manifest);
    manifest.canvas.width = 900;
    await assert.rejects(renderCreative({ ...input(), template: { manifest, dir: tpl.dir, backgroundPath: tpl.backgroundPath } }), (e: unknown) => isRenderError(e) && e.code === "TemplateInvalid");
  });

  test("upper-casing applies to Latin text only", async () => {
    const manifest = structuredClone(tpl.manifest);
    for (const f of manifest.fields) if (f.type === "text" && f.key === "company_name") f.transform = "upper";
    const en = await renderCreative({ ...input(), template: { manifest, dir: tpl.dir, backgroundPath: tpl.backgroundPath } });
    assert.equal(en.report.find((x) => x.key === "company_name")?.text, "ABC INDUSTRIES");
    const hi = await renderCreative({ ...input({ language: "hi" }), template: { manifest, dir: tpl.dir, backgroundPath: tpl.backgroundPath }, values: textValues({ company_name: { text: "आपका नाम" } }) });
    assert.equal(hi.report.find((x) => x.key === "company_name")?.text, "आपका नाम");
  });

  test("text near the edge of the canvas is clipped instead of failing (a shadow or pill never errors)", async () => {
    const manifest = structuredClone(tpl.manifest);
    for (const f of manifest.fields) if (f.type === "text" && f.key === "occasion_title") f.box = { x: 0, y: 0, w: 300, h: 100 };
    const r = await renderCreative({ ...input(), template: { manifest, dir: tpl.dir, backgroundPath: tpl.backgroundPath } });
    assert.equal((await sharp(r.image).metadata()).height, 1080);
  });
});

describe("concurrency and memory", () => {
  test("several renders at once give the same bytes as one at a time", async () => {
    const single = await renderCreative(input());
    const parallel = await Promise.all([renderCreative(input()), renderCreative(input()), renderCreative(input())]);
    for (const p of parallel) assert.ok(p.image.equals(single.image));
  });
});
