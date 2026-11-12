import "server-only";
import type { Language } from "@/lib/studio/domain/language";
import type { Lead, User } from "@/lib/studio/domain/lead";
import { fail, ok, type Result } from "@/lib/studio/result";
import { isRenderError, renderCreative, type OutputFormat, type RenderResult } from "./renderer";
import type { LoadedTemplate } from "./templates/loader";
import type { TemplateRegistry } from "./templates/registry";
import { prepareRender } from "./prepare";

// Renders a template with its own `sample` data (a fake lead and the first approved wording). Used
// by `npm run render-sample`, by template validation (the sample must render without overflow in
// every declared language) and to regenerate preview.png. It takes the same path as a real creative.

export const SAMPLE_USER: User = { id: "sample-user", name: "Priya Sharma", role: "Sales executive", initials: "PS" };

export function sampleLead(template: LoadedTemplate): Lead {
  const s = template.manifest.sample;
  return {
    id: "sample-lead",
    contact: s.contact,
    company: s.company,
    city: "Sample City",
    state: "Sample State",
    // product images are keyed by product code, which is the first word of a product name
    product: s.product ? { id: s.product.split(" ")[0], code: s.product.split(" ")[0], name: s.product } : null,
    source: "Sample",
    addedAt: "2026-10-07T08:30:00+05:30",
    ownerId: SAMPLE_USER.id,
    ownerName: SAMPLE_USER.name,
  };
}

export type SampleRender = RenderResult & { wordingId: string | null };

export async function renderTemplateSample(args: {
  registry: Pick<TemplateRegistry, "fonts">;
  template: LoadedTemplate;
  assetsDir: string;
  language?: Language;
  format?: OutputFormat;
  /** Draw the SAMPLE strip (used by tests; the designer tools leave it off, so previews and goldens are unchanged). */
  sampleMark?: boolean;
  /** Leave the sample contact number out (tests: a poster without a number must look exactly like the design it was made from). */
  omitPhone?: boolean;
}): Promise<Result<SampleRender>> {
  const { registry, template, assetsDir } = args;
  const language = args.language ?? template.manifest.sample.language;
  const prepared = prepareRender({
    template,
    lead: sampleLead(template),
    user: SAMPLE_USER,
    language,
    options: template.copy[language] ?? [],
    variantId: undefined,
    showProduct: true,
    assetsDir,
    // a design with a contact-number field shows its made-up sample number, unless the caller asks for the plain sample
    ...(template.manifest.sample.phone && !args.omitPhone ? { personal: { phone: template.manifest.sample.phone } } : {}),
  });
  if (!prepared.ok) return prepared;
  try {
    const result = await renderCreative({
      template: { manifest: template.manifest, dir: template.dir, backgroundPath: template.backgroundPath },
      values: prepared.data.values,
      language,
      fonts: registry.fonts.families,
      ...(args.format ? { format: args.format } : {}),
      ...(args.sampleMark ? { sampleMark: true } : {}),
    });
    return ok({ ...result, wordingId: prepared.data.wording?.id ?? null });
  } catch (e) {
    if (isRenderError(e)) return fail(e.code === "FieldOverflow" || e.code === "ValueMissing" ? "rule_violation" : "render_failed", `${e.code}: ${e.message}`);
    throw e;
  }
}
