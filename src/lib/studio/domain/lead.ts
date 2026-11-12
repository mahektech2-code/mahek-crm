import { z } from "zod";
import { productSchema } from "./product";
import { normalizeText } from "./text";

const text = z.string().transform(normalizeText).pipe(z.string().min(1));
// A value that may be absent in the source: empty or whitespace-only becomes null.
const optionalText = z
  .string()
  .nullable()
  .transform((v) => (v === null ? null : normalizeText(v) || null));

// A new lead as the app sees it. Read-only: the app never creates or edits leads. The shape is the
// allow-list from the Blueprint (no phone, address, notes, GST or financials).
export const leadSchema = z.object({
  id: text,
  /** Contact person. May be missing; creatives then greet the company. */
  contact: optionalText,
  company: text,
  city: text,
  state: text,
  /** The product the lead asked about. Missing for some leads. */
  product: productSchema.nullable(),
  source: text,
  /** When the lead was added, as an ISO 8601 timestamp with an offset. */
  addedAt: z.string().datetime({ offset: true }),
  ownerId: text,
  ownerName: text,
});
export type Lead = z.infer<typeof leadSchema>;

/** The salesperson using the app. A static mock until authentication exists (future). */
export const userSchema = z.object({
  id: text,
  /** The label the app's own screens use for this person. For a real account it is made from the email, so it is never put on a poster. */
  name: text,
  role: text,
  initials: text,
  /**
   * The name chosen for posters (the "Your Mahek contact" line): explicit account data, never made from an email.
   * `null` means the person has not set one. Absent only for built-in sample users, whose `name` is then used.
   */
  displayName: z.string().nullable().optional(),
});
export type User = z.infer<typeof userSchema>;

/** The salesperson name for a poster, or null when none is set. A blank name counts as none; an email is never substituted. */
export function posterName(user: Pick<User, "name" | "displayName">): string | null {
  if (user.displayName === undefined) return user.name; // a sample user (no account): its name is the sample name
  const name = normalizeText(user.displayName ?? "");
  return name === "" ? null : name;
}

/** Name to greet: the contact, or the company when there is no contact. */
export function greetingName(lead: Pick<Lead, "contact" | "company">): string {
  return lead.contact ?? lead.company;
}
