import "server-only";
import fs from "node:fs";
import path from "node:path";
import { fillPlaceholders, pickOption, type CopyOption } from "@/lib/studio/domain/copy";
import { resolveFieldValues, type ResolvedValue } from "@/lib/studio/domain/fields";
import type { Language } from "@/lib/studio/domain/language";
import type { User } from "@/lib/studio/domain/lead";
import type { Recipient, RecipientKind } from "@/lib/studio/domain/recipient";
import { checkReadiness } from "@/lib/studio/domain/readiness";
import type { LoadedTemplate } from "./templates/loader";
import type { RenderValue } from "./renderer";
import { fail, ok, type Result } from "@/lib/studio/result";

// Steps 4 to 7 of the generation flow: readiness, wording, field values and asset files. Shared by
// the live service and by the sample renderer, so a template sample is rendered by the same code
// path a real creative takes.

export type Prepared = {
  values: Record<string, RenderValue | null>;
  wording: { id: string; label: string; text: string } | null;
};

/** The wording id of a person's own message (an approved wording id is lower-case kebab, so it can never be this). */
export const CUSTOM_WORDING_ID = "custom";

// product codes become file names, so only plain code characters are allowed
const SAFE_CODE = /^[A-Za-z0-9_-]{1,40}$/;

export function resolveAssetPath(assetsDir: string, value: Extract<ResolvedValue, { kind: "asset" }>): string | null {
  const file = value.asset === "logo" ? path.join("logos", `mahek-${value.variant}.png`) : SAFE_CODE.test(value.code) ? path.join("products", `${value.code}.png`) : null;
  if (!file) return null;
  const abs = path.resolve(assetsDir, file);
  return fs.existsSync(abs) ? abs : null;
}

export function prepareRender(args: {
  template: LoadedTemplate;
  lead: Recipient;
  user: User;
  /** Whose creative this is; only changes the wording of a readiness reason. */
  subject?: RecipientKind;
  language: Language;
  /** The wording options for this language, in order. */
  options: readonly CopyOption[];
  variantId: string | undefined;
  showProduct: boolean;
  assetsDir: string;
  /** Checked, poster-only edits that are not part of the recipient: the person's own message and a hand-typed contact number. */
  personal?: { message?: string | undefined; phone?: string | undefined; product?: string | undefined } | undefined;
}): Result<Prepared> {
  const { template, lead, user, language, options, variantId, showProduct, assetsDir, subject = "lead", personal } = args;
  const m = template.manifest;

  const readiness = checkReadiness(lead, user, m, language, subject);
  if (!readiness.ok) return fail("rule_violation", readiness.reason);

  const hasGreeting = m.fields.some((f) => f.type === "text" && f.source === "copy");
  // an edit the design has no place for is refused with a reason, never dropped silently
  if (personal?.phone !== undefined && !m.fields.some((f) => f.key === "contact_phone")) {
    return fail("rule_violation", "This design has no place for a contact number. Remove the number or choose a design that has one.", { fieldErrors: { phone: "not supported by this design" } });
  }
  if (personal?.message !== undefined && !hasGreeting) {
    return fail("rule_violation", "This design has no message area. Remove your message or choose a design that has one.", { fieldErrors: { message: "not supported by this design" } });
  }
  if (personal?.product !== undefined && !m.fields.some((f) => (f.key === "product_name" || f.key === "product_line") && f.type === "text" && f.source === "poster")) {
    return fail("rule_violation", "This design has no place for a typed product name. Remove the product name or choose a design that has one.", { fieldErrors: { product: "not supported by this design" } });
  }
  let wording: Prepared["wording"] = null;
  if (hasGreeting && personal?.message !== undefined) {
    // the person's own message is used exactly as written: it is never swapped for an approved wording
    wording = { id: CUSTOM_WORDING_ID, label: "Your own", text: personal.message };
  } else if (hasGreeting) {
    if (variantId !== undefined && !options.some((o) => o.id === variantId)) {
      return fail("invalid_request", "That wording is not available for this design and language.", { fieldErrors: { variantId: "unknown wording" } });
    }
    const picked = pickOption(options, variantId);
    if (!picked) return fail("rule_violation", "This design has no approved wording in that language.");
    wording = { id: picked.id, label: picked.label, text: fillPlaceholders(picked.text, { company: lead.company, contact: lead.contact, product: lead.product?.name ?? null }) };
  }

  const { values: resolved, missing } = resolveFieldValues({ fields: m.fields, lead, user, language, greeting: wording?.text ?? null, showOptional: showProduct, poster: { phone: personal?.phone, product: personal?.product } });
  if (missing.length > 0) return fail("rule_violation", `Missing: ${missing.join(", ").replaceAll("_", " ")}`);

  const values: Record<string, RenderValue | null> = {};
  for (const [key, v] of Object.entries(resolved)) {
    if (v === null) values[key] = null;
    else if (v.kind === "text") values[key] = { text: v.text };
    else {
      const assetPath = resolveAssetPath(assetsDir, v);
      // a missing file is left as "no value": the renderer applies the field's own `missing` policy
      values[key] = assetPath ? { assetPath } : null;
    }
  }
  return ok({ values, wording });
}
