import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { occasionSchema, type Occasion } from "@/lib/studio/domain/occasion";

const occasionsSchema = z.array(occasionSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((o, i) => {
    if (seen.has(o.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate occasion id "${o.id}"` });
    seen.add(o.id);
  });
});

/** Reads templates/occasions.json. The file's order is the order occasions are shown in. */
export function loadOccasions(templatesDir: string): Occasion[] {
  const file = path.join(templatesDir, "occasions.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${(e as Error).message}`);
  }
  const parsed = occasionsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}
