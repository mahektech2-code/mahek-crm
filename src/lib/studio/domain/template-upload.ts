import { z } from "zod";
import { templateSchema, type Template } from "./template";
import { textProblem } from "./personalization";
import { normalizeText } from "./text";

// Custom poster templates, Phase 1: an admin uploads a finished design (an image) and places text fields on it by hand.
// This file is pure. It holds what the editor and the server share: the canvas sizes, which fields can be placed, the checks
// before approval, and the conversion from a placement draft to an ordinary template manifest (the same format the built-in
// templates use, so the same loader, registry and renderer handle it). Nothing here calls an AI service; the suggestion
// interface at the bottom is only the place a future vision provider would plug in.

// A design of ANY shape is accepted: it is scaled to 1080 pixels wide and its height follows its own proportions, so nothing is
// stretched or cropped. The three common shapes keep their names; every other shape gets an id like "c1080x1527".
export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT_RANGE = { min: 432, max: 2700 } as const; // proportions from 5:2 (wide) to 2:5 (tall)
export type CanvasPreset = { id: string; label: string; width: number; height: number };
export type CanvasId = string;
export const CANVAS_PRESETS: readonly CanvasPreset[] = [
  { id: "square", label: "Square 1080 x 1080", width: 1080, height: 1080 },
  { id: "portrait", label: "Portrait 1080 x 1350", width: 1080, height: 1350 },
  { id: "story", label: "Story 1080 x 1920", width: 1080, height: 1920 },
];
const CUSTOM_CANVAS = /^c([0-9]{3,4})x([0-9]{3,4})$/;
export const CANVAS_ID = /^(square|portrait|story|c[0-9]{3,4}x[0-9]{3,4})$/;
export function canvasById(id: string): CanvasPreset | null {
  const preset = CANVAS_PRESETS.find((c) => c.id === id);
  if (preset) return preset;
  const m = CUSTOM_CANVAS.exec(id);
  if (!m) return null;
  const [width, height] = [Number(m[1]), Number(m[2])];
  if (width !== CANVAS_WIDTH || height < CANVAS_HEIGHT_RANGE.min || height > CANVAS_HEIGHT_RANGE.max) return null;
  return { id, label: `Custom ${width} x ${height}`, width, height };
}

/** The canvas for an image: a standard shape when its proportions match one (within 1%), otherwise 1080 wide at its own proportions; null when it is too wide or too tall. */
export function canvasForSize(width: number, height: number): CanvasPreset | null {
  if (!(width > 0) || !(height > 0)) return null;
  const preset = CANVAS_PRESETS.find((c) => Math.abs(width / height - c.width / c.height) / (c.width / c.height) <= 0.01);
  if (preset) return preset;
  const h = Math.round((CANVAS_WIDTH * height) / width);
  return canvasById(`c${CANVAS_WIDTH}x${h}`);
}

export const MIN_SOURCE_WIDTH = 540;

/** What the editor can place. Every key is one of the app's field keys (domain/fields.ts); nothing is invented. */
export type PlaceableKey = "company_name" | "customer_name" | "product_name" | "greeting" | "contact_phone" | "salesperson" | "city" | "state" | "occasion_title" | "eyebrow" | "footer_site" | "logo";

export type PlaceableDef = {
  label: string;
  hint: string;
  kind: "text" | "static" | "logo";
  /** The made-up text shown in the editor preview. Always marked as a preview sample. */
  sample: string;
  defaultSize: number;
  defaultBox: { w: number; h: number };
  weight: 400 | 700;
};

export const PLACEABLE: Readonly<Record<PlaceableKey, PlaceableDef>> = {
  company_name: { label: "Company name", hint: "The recipient's company, from the CRM", kind: "text", sample: "Sample Traders Pvt Ltd", defaultSize: 54, defaultBox: { w: 800, h: 90 }, weight: 700 },
  customer_name: { label: "Customer / Lead name", hint: "The contact person from the CRM (the company when there is none)", kind: "text", sample: "Sample Customer", defaultSize: 60, defaultBox: { w: 800, h: 100 }, weight: 700 },
  product_name: { label: "Product name", hint: "Typed by hand for each poster or batch (never read from or written to the CRM)", kind: "text", sample: "Sample Product", defaultSize: 48, defaultBox: { w: 800, h: 90 }, weight: 700 },
  greeting: { label: "Promotional message", hint: "One of the approved messages you enter below, or the sender's own message", kind: "text", sample: "Wishing you and your team a successful season.", defaultSize: 40, defaultBox: { w: 800, h: 160 }, weight: 400 },
  contact_phone: { label: "Contact number", hint: "A number typed by hand for the poster; hidden when empty", kind: "text", sample: "+91 98765 43210", defaultSize: 36, defaultBox: { w: 600, h: 70 }, weight: 700 },
  salesperson: { label: "Sender name", hint: "The signed-in user's poster name", kind: "text", sample: "Sample Sender", defaultSize: 36, defaultBox: { w: 600, h: 70 }, weight: 400 },
  city: { label: "City", hint: "The recipient's city from the CRM; hidden when empty", kind: "text", sample: "Sample City", defaultSize: 32, defaultBox: { w: 400, h: 60 }, weight: 400 },
  state: { label: "State", hint: "The recipient's state from the CRM; hidden when empty", kind: "text", sample: "Sample State", defaultSize: 32, defaultBox: { w: 400, h: 60 }, weight: 400 },
  occasion_title: { label: "Fixed headline", hint: "A fixed line you type once; the same on every poster", kind: "static", sample: "Fixed headline", defaultSize: 72, defaultBox: { w: 900, h: 130 }, weight: 700 },
  eyebrow: { label: "Fixed small line", hint: "A fixed small line you type once", kind: "static", sample: "Fixed line", defaultSize: 30, defaultBox: { w: 600, h: 60 }, weight: 400 },
  footer_site: { label: "Fixed footer line", hint: "A fixed footer line you type once", kind: "static", sample: "Footer line", defaultSize: 28, defaultBox: { w: 700, h: 56 }, weight: 400 },
  logo: { label: "Mahek logo", hint: "The approved Mahek logo", kind: "logo", sample: "", defaultSize: 0, defaultBox: { w: 240, h: 120 }, weight: 400 },
};
export const PLACEABLE_KEYS = Object.keys(PLACEABLE) as PlaceableKey[];
export const isPlaceableKey = (k: unknown): k is PlaceableKey => typeof k === "string" && Object.hasOwn(PLACEABLE, k);
/** Keys that carry a recipient's or the sender's own details, as opposed to fixed text and the logo. */
const PERSONAL: ReadonlySet<string> = new Set(["company_name", "customer_name", "product_name", "greeting", "contact_phone", "salesperson", "city", "state"]);

export type Align = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";

export type PlacedField = {
  key: PlaceableKey;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Largest font size in pixels on the canvas; the renderer shrinks text down to `minSize` to fit the box. */
  size: number;
  minSize: number;
  color: string;
  align: Align;
  vAlign: VAlign;
  weight: 400 | 700;
  maxLines: number;
  /** Fixed text, for the "fixed" fields only. */
  text?: string;
  /** Logo only. */
  logoVariant?: "light" | "dark";
};

export type PlacementDraft = {
  name: string;
  canvas: CanvasId;
  /** An existing occasion id from templates/occasions.json. */
  occasion: string;
  fields: PlacedField[];
  /** Approved promotional messages (English) for the "Promotional message" field. */
  messages: string[];
};

export const MAX_FIELDS = 12;
export const MAX_MESSAGES = 5;
export const MESSAGE_MAX_CHARS = 160;
export const NAME_MAX = 60;
export const MIN_BOX = { w: 80, h: 30 } as const;
export const FONT_LIMITS = { min: 12, max: 200 } as const;
const HEX = /^#[0-9a-fA-F]{6}$/;
const LH = 1.2;
const OVERLAP_LIMIT = 0.1;

export type PlacementIssue = { field: PlaceableKey | null; message: string };
export type PlacementCheck = { errors: PlacementIssue[]; warnings: PlacementIssue[] };

const area = (a: { w: number; h: number }) => a.w * a.h;
function overlap(a: PlacedField, b: PlacedField): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.min(area(a), area(b)) : 0;
}

/** Why the template name is not acceptable, or null. */
export function nameProblem(name: string): string | null {
  const n = normalizeText(name);
  if (!n) return "needs a name";
  if (Array.from(n).length > NAME_MAX) return `is too long (at most ${NAME_MAX} characters)`;
  if (/[\u0000-\u001F\u007F<>{}\\`]/.test(n)) return "contains a character that is not allowed";
  return null;
}

/** The structural checks a placement must pass before it can be previewed or approved. Pure; the render check is separate (server). */
export function checkPlacement(draft: PlacementDraft): PlacementCheck {
  const errors: PlacementIssue[] = [];
  const warnings: PlacementIssue[] = [];
  const canvas = canvasById(draft.canvas);
  const err = (field: PlaceableKey | null, message: string) => errors.push({ field, message });
  const np = nameProblem(draft.name);
  if (np) err(null, `The template name ${np}.`);
  if (!canvas) {
    err(null, "Choose one of the supported canvas sizes.");
    return { errors, warnings };
  }
  if (draft.fields.length === 0) err(null, "Place at least one field on the design.");
  if (draft.fields.length > MAX_FIELDS) err(null, `At most ${MAX_FIELDS} fields can be placed.`);
  if (!draft.fields.some((f) => PERSONAL.has(f.key))) err(null, "Place at least one personalized field (for example the company name or the lead name), otherwise every poster would be identical.");

  const seen = new Set<string>();
  for (const f of draft.fields) {
    const def = PLACEABLE[f.key];
    const label = def.label;
    if (seen.has(f.key)) err(f.key, `${label} is placed twice. Each field can be placed once.`);
    seen.add(f.key);
    const ints = [f.x, f.y, f.w, f.h, f.size, f.minSize, f.maxLines];
    if (!ints.every((n) => Number.isInteger(n))) {
      err(f.key, `${label}: position and size must be whole numbers.`);
      continue;
    }
    if (f.x < 0 || f.y < 0 || f.x + f.w > canvas.width || f.y + f.h > canvas.height) err(f.key, `${label} goes outside the design. Move or resize it so it is fully inside.`);
    if (f.w < MIN_BOX.w || f.h < MIN_BOX.h) err(f.key, `${label} is too small (at least ${MIN_BOX.w} x ${MIN_BOX.h}).`);
    if (def.kind === "logo") {
      if (f.logoVariant !== undefined && f.logoVariant !== "light" && f.logoVariant !== "dark") err(f.key, "The logo variant must be light or dark.");
      continue;
    }
    if (f.size < FONT_LIMITS.min || f.size > FONT_LIMITS.max) err(f.key, `${label}: font size must be between ${FONT_LIMITS.min} and ${FONT_LIMITS.max}.`);
    if (f.minSize < FONT_LIMITS.min || f.minSize > f.size) err(f.key, `${label}: the smallest size must be between ${FONT_LIMITS.min} and the font size.`);
    if (f.maxLines < 1 || f.maxLines > 6) err(f.key, `${label}: lines must be between 1 and 6.`);
    if (!HEX.test(f.color)) err(f.key, `${label}: choose a valid colour.`);
    if (!["left", "center", "right"].includes(f.align) || !["top", "middle", "bottom"].includes(f.vAlign)) err(f.key, `${label}: alignment is not valid.`);
    if (f.weight !== 400 && f.weight !== 700) err(f.key, `${label}: weight must be regular or bold.`);
    if (f.minSize * LH > f.h) err(f.key, `${label} is too short for even one line at the smallest size. Make it taller or lower the smallest size.`);
    if (f.minSize * LH * f.maxLines > f.h * 1.5) warnings.push({ field: f.key, message: `${label} allows more lines than its height can hold at the smallest size.` });
    if (def.kind === "static") {
      const t = normalizeText(f.text ?? "");
      const p = t ? textProblem(t, "message") : "cannot be empty";
      if (p) err(f.key, `${label}: the fixed text ${p}.`);
    }
  }
  for (let i = 0; i < draft.fields.length; i++) {
    for (let j = i + 1; j < draft.fields.length; j++) {
      const a = draft.fields[i]!;
      const b = draft.fields[j]!;
      if (a.key !== b.key && overlap(a, b) > OVERLAP_LIMIT) err(a.key, `${PLACEABLE[a.key].label} overlaps ${PLACEABLE[b.key].label}. Move one of them so the text does not collide.`);
    }
  }

  const hasGreeting = draft.fields.some((f) => f.key === "greeting");
  if (hasGreeting) {
    if (draft.messages.length === 0) err("greeting", "Add at least one approved promotional message (or remove the message field).");
    if (draft.messages.length > MAX_MESSAGES) err("greeting", `At most ${MAX_MESSAGES} messages.`);
    draft.messages.forEach((m, i) => {
      const n = normalizeText(m);
      if (!n) return err("greeting", `Message ${i + 1} is empty.`);
      if (Array.from(n).length > MESSAGE_MAX_CHARS) err("greeting", `Message ${i + 1} is too long (at most ${MESSAGE_MAX_CHARS} characters).`);
      const p = textProblem(n, "message");
      if (p) err("greeting", `Message ${i + 1} ${p}.`);
    });
  } else if (draft.messages.length > 0) warnings.push({ field: null, message: "Messages are saved but unused: no promotional message field is placed." });
  return { errors, warnings };
}

export const FONT_FAMILY_ID = "noto-sans";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");

/** An id for a new custom template: "custom-<name>-<random>". Kebab-case, unique, never a built-in id. */
export function newTemplateId(name: string, random: string): string {
  const s = slug(name);
  return `custom-${s ? `${s}-` : ""}${random.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`;
}

export type ManifestMeta = { id: string; version: string; status: "draft" | "approved"; approvedBy: string; approvedAt: string; description?: string };

/** The made-up values the preview uses. */
export const PREVIEW_SAMPLE = { contact: "Sample Customer", company: "Sample Traders Pvt Ltd", product: "Sample Product", phone: "+91 98765 43210" } as const;

/** Turns a placement into a template manifest (unvalidated shape; callers run `buildManifest`). */
export function manifestFromDraft(draft: PlacementDraft, meta: ManifestMeta): unknown {
  const canvas = canvasById(draft.canvas)!;
  const fields = draft.fields.map((f) => {
    const def = PLACEABLE[f.key];
    const box = { x: f.x, y: f.y, w: f.w, h: f.h };
    if (def.kind === "logo") return { key: "logo", type: "image", source: "asset", asset: "logo", variant: f.logoVariant ?? "light", fit: "contain", missing: "hide", box };
    const common = {
      key: f.key,
      type: "text",
      box,
      font: def.kind === "static" || f.key === "greeting" ? "body" : "name",
      weight: f.weight,
      color: f.color,
      align: f.align,
      vAlign: f.vAlign,
      maxFont: f.size,
      minFont: f.minSize,
      step: 2,
      maxLines: f.maxLines,
      lh: LH,
      overflow: "ellipsis",
    };
    switch (f.key) {
      case "company_name":
        return { ...common, source: "crm", crmPath: "lead.company", required: true };
      case "customer_name":
        return { ...common, source: "crm", crmPath: "lead.contact", fallback: "lead.company", required: true };
      case "product_name":
        return { ...common, source: "poster" };
      case "greeting":
        return { ...common, source: "copy", maxChars: MESSAGE_MAX_CHARS };
      case "contact_phone":
        return { ...common, source: "poster" };
      case "salesperson":
        return { ...common, source: "user" };
      case "city":
        return { ...common, source: "crm", crmPath: "lead.city" };
      case "state":
        return { ...common, source: "crm", crmPath: "lead.state" };
      default:
        return { ...common, source: "static", text: { en: normalizeText(f.text ?? "") } };
    }
  });
  const font = { en: FONT_FAMILY_ID };
  return {
    schemaVersion: 1,
    id: meta.id,
    name: normalizeText(draft.name),
    description: meta.description ?? "Custom uploaded design",
    version: meta.version,
    status: meta.status,
    approval: { approvedBy: meta.approvedBy, approvedAt: meta.approvedAt },
    occasion: draft.occasion,
    category: "promotion",
    audiences: ["lead", "customer"],
    languages: ["en"],
    requires: [],
    tags: ["custom"],
    canvas: { width: canvas.width, height: canvas.height, defaultFormat: "png", jpegQuality: 90 },
    background: "background.png",
    fonts: { display: font, body: font, name: font },
    layers: [],
    fields,
    sample: { contact: PREVIEW_SAMPLE.contact, company: PREVIEW_SAMPLE.company, product: PREVIEW_SAMPLE.product, language: "en", ...(draft.fields.some((f) => f.key === "contact_phone") ? { phone: PREVIEW_SAMPLE.phone } : {}) },
  };
}

export function buildManifest(draft: PlacementDraft, meta: ManifestMeta): { ok: true; manifest: Template } | { ok: false; problems: string[] } {
  const parsed = templateSchema.safeParse(manifestFromDraft(draft, meta));
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`) };
}

/** The copy.json for a draft: the approved messages, in English. */
export function copyFromDraft(draft: PlacementDraft): Record<string, { id: string; label: string; text: string }[]> {
  if (!draft.fields.some((f) => f.key === "greeting")) return {};
  return { en: draft.messages.map((text, i) => ({ id: `message-${i + 1}`, label: `Message ${i + 1}`, text: normalizeText(text) })) };
}

/** A box for a freshly added field: the default size, centred horizontally, below the fields already placed. */
export function defaultPlacement(key: PlaceableKey, canvas: CanvasPreset, existing: readonly PlacedField[]): PlacedField {
  const def = PLACEABLE[key];
  const w = Math.min(def.defaultBox.w, canvas.width - 40);
  const h = Math.min(def.defaultBox.h, canvas.height - 40);
  const bottom = existing.reduce((m, f) => Math.max(m, f.y + f.h), 0);
  const below = bottom + 20;
  const y = below + h <= canvas.height ? below : Math.round((canvas.height - h) / 2);
  const size = def.defaultSize || 40;
  return {
    key,
    x: Math.round((canvas.width - w) / 2),
    y,
    w,
    h,
    size,
    minSize: Math.max(FONT_LIMITS.min, Math.round(size * 0.5)),
    color: "#FFFFFF",
    align: "center",
    vAlign: "middle",
    weight: def.weight,
    maxLines: key === "greeting" ? 3 : 1,
    ...(def.kind === "static" ? { text: def.sample } : {}),
    ...(def.kind === "logo" ? { logoVariant: "light" as const } : {}),
  };
}

// ---- the future AI seam -------------------------------------------------------------------------------------------------------
// A placement suggester proposes field boxes for an uploaded image. Phase 1 has none connected: `NO_SUGGESTER` always answers
// "unavailable", the editor shows no suggestion button, and no network call is made anywhere. A later phase can implement this
// interface with a vision provider; its output is only ever a starting `PlacedField[]` that the admin still reviews, edits and approves.

export type PlacementSuggestion = { fields: PlacedField[]; note?: string };
export type PlacementSuggester = {
  readonly available: boolean;
  suggest(input: { canvas: CanvasId; image: Uint8Array }): Promise<PlacementSuggestion | null>;
};
export const NO_SUGGESTER: PlacementSuggester = { available: false, suggest: async () => null };

// ---- reading an untrusted placement ---------------------------------------------------------------------------------------------
// A placement arrives from the browser as JSON. This is the only way it becomes a `PlacementDraft`: unknown keys are refused, every
// number is a bounded integer, every string is bounded. `checkPlacement` then applies the rules that need to explain themselves.

const int = (max: number) => z.number().int().min(-100_000).max(max);
const placedFieldSchema = z
  .object({
    key: z.string().refine(isPlaceableKey, "not a field that can be placed"),
    x: int(10_000),
    y: int(10_000),
    w: int(10_000),
    h: int(10_000),
    size: int(1_000),
    minSize: int(1_000),
    color: z.string().max(9),
    align: z.enum(["left", "center", "right"]),
    vAlign: z.enum(["top", "middle", "bottom"]),
    weight: z.union([z.literal(400), z.literal(700)]),
    maxLines: int(100),
    text: z.string().max(200).optional(),
    logoVariant: z.enum(["light", "dark"]).optional(),
  })
  .strict();

export const placementDraftSchema = z
  .object({
    name: z.string().max(400),
    canvas: z.string().regex(CANVAS_ID),
    occasion: z.string().regex(/^[a-z][a-z0-9-]*$/).max(40),
    fields: z.array(placedFieldSchema).max(MAX_FIELDS + 4),
    messages: z.array(z.string().max(1_000)).max(MAX_MESSAGES + 4),
  })
  .strict();

export function parsePlacement(raw: unknown): { ok: true; draft: PlacementDraft } | { ok: false; message: string } {
  const parsed = placementDraftSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "The placement is not valid." };
  return { ok: true, draft: parsed.data as PlacementDraft };
}
