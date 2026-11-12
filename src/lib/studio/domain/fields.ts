// The personalization field registry: the single list of field keys the app understands.
// A template field names one of these keys; the registry says what the key means, which sources and
// lead paths may feed it, and (in resolveFieldValues) how its value is produced. The RENDERER never
// sees any of this: it receives finished values and draws them, so a new field means a new registry
// entry and never a renderer change.
import type { Recipient } from "./recipient";
import { posterName, type User } from "./lead";
import type { Language } from "./language";
import { firstWord } from "./text";

export type FieldType = "text" | "image";
/** `poster` is a value typed in by the person making the poster (the contact number): never read from the CRM. */
export type FieldSource = "crm" | "copy" | "static" | "asset" | "user" | "poster";

export type FieldDef = {
  type: FieldType;
  description: string;
  sources: readonly FieldSource[];
  /** Lead paths a `crm` field may bind to. */
  crmPaths?: readonly string[];
  /** Lead paths a `crm` field may fall back to when the first one is empty. */
  fallbackPaths?: readonly string[];
  /** Asset names an `asset` field may bind to. */
  assets?: readonly string[];
};

export const FIELD_REGISTRY = {
  logo: { type: "image", description: "Approved Mahek logo variant", sources: ["asset"], assets: ["logo"] },
  occasion_title: { type: "text", description: "The festival or occasion headline, fixed per language by the template", sources: ["static"] },
  customer_name: { type: "text", description: "The lead's contact person, or the company when there is none", sources: ["crm"], crmPaths: ["lead.contact"], fallbackPaths: ["lead.company"] },
  company_name: { type: "text", description: "The lead's company", sources: ["crm"], crmPaths: ["lead.company"] },
  contact_first_name: { type: "text", description: "First word of the contact's name", sources: ["crm"], crmPaths: ["lead.contact"], fallbackPaths: ["lead.company"] },
  greeting: { type: "text", description: "The chosen approved wording with placeholders filled", sources: ["copy"] },
  product_line: { type: "text", description: "The lead's product name as a line of text, or a product name typed for this poster", sources: ["crm", "poster"], crmPaths: ["lead.product_name"] },
  product_name: { type: "text", description: "The lead's product name as a headline, or a product name typed for this poster", sources: ["crm", "poster"], crmPaths: ["lead.product_name"] },
  product_image: { type: "image", description: "Approved pack image for the lead's product code", sources: ["asset"], assets: ["product_image"] },
  salesperson: { type: "text", description: "The signed-in user's name", sources: ["crm", "user"], crmPaths: ["lead.owner"] },
  contact_phone: { type: "text", description: "A contact number typed in by hand for this poster only; drawn only where a design has this field", sources: ["poster"] },
  footer_site: { type: "text", description: "Fixed website line", sources: ["static"] },
  year_mark: { type: "text", description: "Large year mark, fixed by the template", sources: ["static"] },
  eyebrow: { type: "text", description: "Small label above a headline, fixed per language", sources: ["static"] },
  city: { type: "text", description: "The lead's city", sources: ["crm"], crmPaths: ["lead.city"] },
  state: { type: "text", description: "The lead's state", sources: ["crm"], crmPaths: ["lead.state"] },
} as const satisfies Record<string, FieldDef>;

export type FieldKey = keyof typeof FIELD_REGISTRY;
export const FIELD_KEYS = Object.keys(FIELD_REGISTRY) as FieldKey[];
export const isFieldKey = (key: string): key is FieldKey => Object.hasOwn(FIELD_REGISTRY, key);

/** A finished value for one field. Asset values are references; files are resolved server-side. */
export type ResolvedValue =
  | { kind: "text"; text: string }
  | { kind: "asset"; asset: "logo"; variant: "light" | "dark" }
  | { kind: "asset"; asset: "product_image"; code: string };

// What resolution needs from a template. Structural, so the template schema (domain/template.ts)
// satisfies it without this file depending on that one.
export type ResolvableField =
  | {
      type: "text";
      key: string;
      source: FieldSource;
      crmPath?: string | undefined;
      fallback?: string | undefined;
      required?: boolean | undefined;
      optional?: boolean | undefined;
      prefix?: Partial<Record<Language, string>> | undefined;
      text?: Partial<Record<Language, string>> | undefined;
    }
  | { type: "image"; key: string; asset: string; variant?: "light" | "dark" | undefined; required?: boolean | undefined; optional?: boolean | undefined };

export type ResolveInput = {
  fields: readonly ResolvableField[];
  /** The recipient of the creative: a lead, or a customer (with its selected product). Templates still call its paths `lead.*`. */
  lead: Recipient;
  user: User;
  language: Language;
  /** The chosen approved wording with placeholders already filled, or null if none. */
  greeting: string | null;
  /** When false, fields marked `optional` (for example the product line) are left out. */
  showOptional: boolean;
  /** Values the person typed for this poster. Only a `poster` field reads them. */
  poster?: { phone?: string | undefined; product?: string | undefined } | undefined;
};

export type ResolveResult = { values: Record<string, ResolvedValue | null>; missing: string[] };

function leadText(path: string, lead: Recipient, user: User): string | null {
  switch (path) {
    case "lead.contact":
      return lead.contact;
    case "lead.company":
      return lead.company;
    case "lead.product_name":
      return lead.product?.name ?? null;
    case "lead.owner":
      return posterName(user);
    case "lead.city":
      return lead.city;
    case "lead.state":
      return lead.state;
    default:
      return null;
  }
}

/**
 * Turns a template's field list plus a lead and choices into finished values. Pure and
 * deterministic. A required field with no value is reported in `missing` (readiness uses this); an
 * optional field that is switched off, or has no value, resolves to null and is simply not drawn.
 */
export function resolveFieldValues(input: ResolveInput): ResolveResult {
  const { fields, lead, user, language, greeting, showOptional, poster } = input;
  const values: Record<string, ResolvedValue | null> = {};
  const missing: string[] = [];

  for (const f of fields) {
    if (f.type === "image") {
      let value: ResolvedValue | null = null;
      if (f.asset === "logo") value = { kind: "asset", asset: "logo", variant: f.variant ?? "light" };
      else if (f.asset === "product_image" && lead.product) value = { kind: "asset", asset: "product_image", code: lead.product.code };
      if (f.optional && !showOptional) value = null;
      if (!value && f.required) missing.push(f.key);
      values[f.key] = value;
      continue;
    }

    let text: string | null = null;
    if (f.source === "static") text = f.text?.[language] ?? f.text?.en ?? null;
    else if (f.source === "copy") text = greeting;
    else if (f.source === "user") text = posterName(user);
    else if (f.source === "poster") text = f.key === "contact_phone" ? (poster?.phone ?? null) : f.key === "product_name" || f.key === "product_line" ? (poster?.product ?? null) : null;
    else if (f.source === "crm" && f.crmPath) {
      text = leadText(f.crmPath, lead, user);
      if (!text && f.fallback) text = leadText(f.fallback, lead, user);
      if (f.key === "contact_first_name" && text) text = firstWord(text);
    }
    if (f.optional && !showOptional) text = null;
    if (!text && f.required) missing.push(f.key);
    if (text && f.prefix) text = (f.prefix[language] ?? f.prefix.en ?? "") + text;
    values[f.key] = text ? { kind: "text", text } : null;
  }
  return { values, missing };
}
