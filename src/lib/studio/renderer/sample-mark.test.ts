import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import sharp from "sharp";
import { renderTemplateSample } from "../sample";
import { createTemplateRegistry } from "../templates/registry";
import { SAMPLE_STRIP_HEIGHT } from "./compose";

// The optional SAMPLE strip: off by default (so every existing image is unchanged), a visible red strip with white
// lettering across the top when asked for, and it never covers anything a template draws.

const root = path.resolve(process.cwd(), "studio");
const assetsDir = path.join(root, "assets");
const registry = createTemplateRegistry({ templatesDir: path.join(root, "templates"), assetsDir });

async function rowStats(image: Buffer, y: number): Promise<{ redShare: number; lightShare: number }> {
  const { data, info } = await sharp(image).extract({ left: 0, top: y, width: 1080, height: 1 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  let light = 0;
  for (let x = 0; x < info.width; x++) {
    const [r, g, b] = [data[x * 3]!, data[x * 3 + 1]!, data[x * 3 + 2]!];
    if (Math.abs(r - 179) < 12 && Math.abs(g - 38) < 12 && Math.abs(b - 30) < 12) red++; // the strip's own colour, not just 'reddish'
    if (r > 235 && g > 235 && b > 235) light++;
  }
  return { redShare: red / info.width, lightShare: light / info.width };
}

describe("the SAMPLE strip", () => {
  test("by default there is no strip at all", async () => {
    const template = registry.get("diwali-classic")!;
    const plain = await renderTemplateSample({ registry, template, assetsDir, language: "en", format: "png" });
    assert.ok(plain.ok);
    assert.ok((await rowStats(plain.data.image, 4)).redShare < 0.05, "no red strip");
  });

  test("with the mark on, every approved design has a red strip across the top with white lettering in it", async () => {
    for (const template of registry.list()) {
      const language = template.manifest.sample.language;
      const marked = await renderTemplateSample({ registry, template, assetsDir, language, format: "png", sampleMark: true });
      assert.ok(marked.ok, template.manifest.id);
      assert.ok((await rowStats(marked.data.image, 4)).redShare > 0.9, `${template.manifest.id}: red across the width`);
      assert.ok((await rowStats(marked.data.image, SAMPLE_STRIP_HEIGHT - 1)).redShare > 0.9, `${template.manifest.id}: the strip reaches its full height`);
      const lettering = Math.max(...(await Promise.all([14, 18, 22, 26, 30].map((y) => rowStats(marked.data.image, y)))).map((s) => s.lightShare));
      assert.ok(lettering > 0.01, `${template.manifest.id}: white lettering inside the strip`);
    }
  });

  test("the strip is not drawn over anything the design draws", async () => {
    const template = registry.get("diwali-classic")!;
    const marked = await renderTemplateSample({ registry, template, assetsDir, language: "en", format: "png", sampleMark: true });
    const plain = await renderTemplateSample({ registry, template, assetsDir, language: "en", format: "png" });
    assert.ok(marked.ok && plain.ok);
    // below the strip the two images are identical: the mark changes nothing else
    const below = (b: Buffer) => sharp(b).extract({ left: 0, top: SAMPLE_STRIP_HEIGHT, width: 1080, height: 1080 - SAMPLE_STRIP_HEIGHT }).raw().toBuffer();
    assert.ok((await below(marked.data.image)).equals(await below(plain.data.image)));
  });

  test("no design draws anything inside the strip's height, so the strip never hides a field or a layer", () => {
    for (const template of registry.list()) {
      const m = template.manifest;
      for (const f of m.fields) assert.ok(f.box.y >= SAMPLE_STRIP_HEIGHT, `${m.id}: field ${f.key} starts at y=${f.box.y}, inside the ${SAMPLE_STRIP_HEIGHT}px strip`);
      for (const l of m.layers) assert.ok(l.box.y >= SAMPLE_STRIP_HEIGHT, `${m.id}: layer ${l.file} starts at y=${l.box.y}, inside the strip`);
    }
  });
});
