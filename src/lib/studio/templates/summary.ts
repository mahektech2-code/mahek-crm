import "server-only";
import { offersTo } from "@/lib/studio/domain/audience";
import type { RecipientKind } from "@/lib/studio/domain/recipient";
import type { TemplateSummary } from "@/lib/studio/domain/template";
import type { LoadedTemplate } from "./loader";
import type { TemplateRegistry } from "./registry";

export function summarize(registry: TemplateRegistry, t: LoadedTemplate): TemplateSummary {
  const m = t.manifest;
  const occasion = registry.occasion(m.occasion);
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    occasion: m.occasion,
    occasionLabel: occasion?.label ?? m.occasion,
    ...(occasion?.color ? { occasionColor: occasion.color } : {}),
    languages: m.languages,
    version: m.version,
    requiresProduct: m.requires.includes("product"),
  };
}

export const previewSrc = (templateId: string) => `/api/templates/${encodeURIComponent(templateId)}/preview`;

/** The occasion id from a URL parameter if it is a real occasion that has a design, otherwise null. */
export function parseOccasionParam(registry: TemplateRegistry, value: string | string[] | undefined, audience?: RecipientKind): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return registry.occasionsWithTemplates(audience).some((o) => o.id === v) ? (v as string) : null;
}

/**
 * The design id from a URL parameter if it is a real, approved design that is offered to this kind of recipient, otherwise null.
 * The address is only a hint: a wrong or foreign value is ignored and the normal design list is shown.
 */
export function parseTemplateParam(registry: TemplateRegistry, value: string | string[] | undefined, audience: RecipientKind): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return null;
  const template = registry.get(v);
  return template && offersTo(template.manifest, audience) ? v : null;
}
