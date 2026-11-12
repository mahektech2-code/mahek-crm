import { z } from "zod";
import { normalizeText } from "./text";

const text = z.string().transform(normalizeText).pipe(z.string().min(1));

export const productSchema = z.object({
  id: text,
  /** Product code, for example "M1433". Keys the approved pack image in assets/products/. */
  code: text,
  name: text,
  packSize: text.optional(),
});
export type Product = z.infer<typeof productSchema>;
