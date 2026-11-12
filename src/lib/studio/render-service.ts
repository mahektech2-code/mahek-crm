import "server-only";
import crypto from "node:crypto";
import sharp from "sharp";
import { offersTo } from "./domain/audience";
import type { Language } from "./domain/language";
import type { User } from "./domain/lead";
import { applyPersonalization, messageScriptProblem, parsePersonalization, type Personalization } from "./domain/personalization";
import type { Recipient, RecipientKind } from "./domain/recipient";
import { wordingForAudience } from "./domain/template-audience";
import { initials } from "./domain/text";
import { createByteCache } from "./cache";
import { createLimiter } from "./limiter";
import { ASSETS_DIR } from "./paths";
import { prepareRender } from "./prepare";
import { isRenderError, renderCreative, type FieldReport, type OutputFormat } from "./renderer";
import { getStudioRegistry } from "./registry-service";
import type { LoadedTemplate } from "./templates/loader";
import type { TemplateRegistry } from "./templates/registry";

/* ---------------------------------------------------------------------------
 * A RECIPE IN, AN IMAGE OUT.
 *
 * Everything a poster needs is in its recipe — the design and its version, the
 * language, the wording, the recipient as they stood, the sender's name and the
 * poster-only edits — so the same recipe draws the same picture whenever it is
 * asked, and a poster is stored as its recipe rather than as a file.
 *
 * THE BOX THIS RUNS ON HAS ONE CPU AND A GIGABYTE, shared with the CRM, the
 * ERP and Postgres. So the renderer draws one poster at a time (a second waits
 * rather than doubling the memory), libvips keeps a small cache and one
 * thread, and a finished image is kept in a small in-process cache so opening
 * a poster twice does not draw it twice.
 * ------------------------------------------------------------------------- */

sharp.concurrency(1);
sharp.cache({ memory: 48, files: 0, items: 40 });

const limiter = createLimiter(1);
const images = createByteCache<{ image: Buffer; format: OutputFormat }>(24, 16 * 1024 * 1024);

export type PosterRecipe = {
  audience: RecipientKind;
  recipient: Recipient;
  senderName: string | null;
  templateId: string;
  /** Absent means the current version; a stored poster always names the one it was made with. */
  templateVersion?: string | undefined;
  language: Language;
  variantId?: string | null | undefined;
  showProduct: boolean;
  personal: Personalization;
};

export type Prepared = {
  template: LoadedTemplate;
  registry: TemplateRegistry;
  values: Parameters<typeof renderCreative>[0]["values"];
  wording: { id: string; label: string; text: string } | null;
  edits: Personalization;
};

export type StudioFailure = { ok: false; error: string; field?: string };
export type StudioResult<T> = { ok: true; data: T } | StudioFailure;

/** The sender as the renderer knows a person. The poster prints `displayName`. */
export function senderAsUser(senderName: string | null): User {
  const name = (senderName ?? "").trim();
  return { id: "sender", name: name || "Mahek", role: "", initials: initials(name || "M"), displayName: name || null };
}

/** Resolves a recipe against the designs as they stand: right design, right audience, right language, wording that exists. */
export async function prepareRecipe(recipe: PosterRecipe): Promise<StudioResult<Prepared>> {
  const registry = await getStudioRegistry();
  const template = registry.getVersion(recipe.templateId, recipe.templateVersion);
  if (!template || !offersTo(template.manifest, recipe.audience)) return { ok: false, error: "This design is not available." };
  if (!registry.languagesFor(template, recipe.audience).includes(recipe.language)) return { ok: false, error: "That language is not available for this design.", field: "language" };

  const checked = parsePersonalization(recipe.personal ?? {});
  if (!checked.ok) {
    const [field, message] = Object.entries(checked.fieldErrors ?? {})[0] ?? ["", checked.error];
    return { ok: false, error: field ? `${field[0]!.toUpperCase()}${field.slice(1)} ${message}.` : checked.error, ...(field ? { field } : {}) };
  }
  const edits = checked.data;
  if (edits.message !== undefined) {
    const script = messageScriptProblem(edits.message, recipe.language);
    if (script) return { ok: false, error: `Your message ${script}. Write it in English or in the language of the design.`, field: "message" };
  }
  const lead = applyPersonalization(recipe.recipient, edits);
  const options = wordingForAudience(template.manifest, template.copy[recipe.language] ?? [], recipe.audience);
  const prepared = prepareRender({
    template,
    lead,
    user: senderAsUser(recipe.senderName),
    subject: recipe.audience,
    language: recipe.language,
    options,
    variantId: recipe.variantId ?? undefined,
    showProduct: recipe.showProduct,
    assetsDir: ASSETS_DIR,
    personal: { message: edits.message, phone: edits.phone, product: edits.product },
  });
  if (!prepared.ok) return { ok: false, error: prepared.error, ...(prepared.fieldErrors ? { field: Object.keys(prepared.fieldErrors)[0] } : {}) };
  /* A picture the design cannot be drawn without, and which there is no file
     for — a product with no pack shot. The renderer would refuse it at the
     last moment; saying so here is what lets the design list grey it out. */
  const missingPicture = template.manifest.fields.find((f) => f.type === "image" && f.missing === "block" && !prepared.data.values[f.key]);
  if (missingPicture) {
    return {
      ok: false,
      error: missingPicture.key === "product_image" ? "Needs a picture of their product, and none of their products has one yet." : "This design needs a picture this record does not have.",
    };
  }
  return { ok: true, data: { template, registry, values: prepared.data.values, wording: prepared.data.wording, edits } };
}

export type Rendered = { image: Buffer; format: OutputFormat; width: number; height: number; report: FieldReport[]; template: { id: string; version: string; name: string; occasion: string }; wording: { id: string; label: string } | null };

/** Draws a recipe. Refuses, in words, a design the data cannot fill or a typed line that would not fit. */
export async function renderRecipe(recipe: PosterRecipe, format?: OutputFormat): Promise<StudioResult<Rendered>> {
  const p = await prepareRecipe(recipe);
  if (!p.ok) return p;
  const { template, registry, values, wording, edits } = p.data;
  const m = template.manifest;
  const fmt = format ?? m.canvas.defaultFormat;
  const meta = { template: { id: m.versionOf ?? m.id, version: m.version, name: m.name, occasion: m.occasion }, wording: wording ? { id: wording.id, label: wording.label } : null };
  const key = crypto.createHash("sha256").update(JSON.stringify({ t: m.id, v: m.version, l: recipe.language, f: fmt, values })).digest("hex");
  const hit = images.get(key);
  if (hit) return { ok: true, data: { image: hit.image, format: hit.format, width: m.canvas.width, height: m.canvas.height, report: [], ...meta } };

  let result: Awaited<ReturnType<typeof renderCreative>> | null = null;
  let last: unknown;
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    try {
      result = await limiter.run(() => renderCreative({ template: { manifest: m, dir: template.dir, backgroundPath: template.backgroundPath }, values, language: recipe.language, fonts: registry.fonts.families, format: fmt }));
    } catch (e) {
      last = e;
      if (isRenderError(e) && e.code !== "RenderFailed") break;
    }
  }
  if (!result) {
    if (isRenderError(last) && last.code === "FieldOverflow") return { ok: false, error: "A name or line of text is too long to fit this design. Shorten it on this poster, or choose a different design." };
    if (isRenderError(last) && last.code === "ValueMissing") return { ok: false, error: "This design needs something this record does not have, such as a product picture. Choose a different design." };
    console.error("[studio] render failed:", last instanceof Error ? last.message : last);
    return { ok: false, error: "The poster could not be drawn. Try again; if it keeps failing, tell us with the Tell us button." };
  }
  const clipped = result.report.find((r) => r.status === "shortened" && ((r.key === "greeting" && edits.message !== undefined) || (r.key === "contact_phone" && edits.phone !== undefined)));
  if (clipped) {
    return clipped.key === "greeting"
      ? { ok: false, error: "Your message is too long to fit this design. Shorten it, or choose a different design.", field: "message" }
      : { ok: false, error: "The contact number does not fit this design.", field: "phone" };
  }
  images.set(key, { image: result.image, format: result.format });
  return { ok: true, data: { image: result.image, format: result.format, width: result.width, height: result.height, report: result.report, ...meta } };
}

/** A design's sample render, for a design that has no preview file yet (an upload being placed). */
export { renderTemplateSample } from "./sample";
