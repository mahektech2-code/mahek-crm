import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { studioDesigns } from "@/db/schema";
import { fileStorage } from "@/lib/storage";
import { ASSETS_DIR, TEMPLATES_DIR } from "./paths";
import {
  createTemplateRegistry,
  type TemplateRegistry,
} from "./templates/registry";

/* ---------------------------------------------------------------------------
 * THE ONE REGISTRY OF DESIGNS: the approved folders shipped in studio/templates
 * plus every uploaded design somebody has approved.
 *
 * The renderer and the loader read FILES — a template is a folder with a
 * template.json, a copy.json, a background and a preview — and that is the
 * format the standalone Studio proved, so an approved upload is written out as
 * exactly that folder under the OS temp directory and read by the same loader.
 * The database row and file storage stay the truth; the folder is a cache that
 * a restart, a second process or a wiped /tmp rebuilds from them.
 *
 * The registry is rebuilt only when the set of approved uploads changes —
 * `stamp` is their ids and versions — because loading validates every folder
 * and reading eight backgrounds on every request would be wasted work.
 * ------------------------------------------------------------------------- */

const UPLOADED_ROOT = path.join(os.tmpdir(), "mahek-studio-designs");

let cached: { stamp: string; registry: TemplateRegistry } | null = null;
let building: Promise<TemplateRegistry> | null = null;

async function materialise(row: {
  id: string;
  version: string;
  manifest: unknown;
  copy: unknown;
  backgroundRef: string;
  previewRef: string | null;
}): Promise<void> {
  const dir = path.join(UPLOADED_ROOT, "approved", row.id);
  const marker = path.join(dir, ".version");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === row.version)
    return;
  fs.mkdirSync(dir, { recursive: true });
  const [background, preview] = await Promise.all([
    fileStorage.read(row.backgroundRef),
    row.previewRef ? fileStorage.read(row.previewRef) : null,
  ]);
  fs.writeFileSync(
    path.join(dir, "template.json"),
    JSON.stringify(row.manifest, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "copy.json"),
    JSON.stringify(row.copy ?? {}, null, 2),
  );
  fs.writeFileSync(path.join(dir, "background.png"), Buffer.from(background));
  if (preview)
    fs.writeFileSync(path.join(dir, "preview.png"), Buffer.from(preview));
  fs.writeFileSync(marker, row.version);
}

/**
 * The designs as they stand now. Approved uploads are read from the database
 * on every call (a handful of short rows), and the folders are only written
 * the first time a design is seen by this process.
 */
export async function getStudioRegistry(): Promise<TemplateRegistry> {
  const rows = await db
    .select({ id: studioDesigns.id, version: studioDesigns.version })
    .from(studioDesigns)
    .where(eq(studioDesigns.status, "approved"));
  const stamp = rows
    .map((r) => `${r.id}@${r.version}`)
    .sort()
    .join("|");
  if (cached && cached.stamp === stamp) return cached.registry;
  if (building) return building;
  const build = (async () => {
    const full = rows.length
      ? await db
          .select({
            id: studioDesigns.id,
            version: studioDesigns.version,
            manifest: studioDesigns.manifest,
            copy: studioDesigns.copy,
            backgroundRef: studioDesigns.backgroundRef,
            previewRef: studioDesigns.previewRef,
          })
          .from(studioDesigns)
          .where(eq(studioDesigns.status, "approved"))
      : [];
    const extraTemplatesDir = path.join(UPLOADED_ROOT, "approved");
    fs.mkdirSync(extraTemplatesDir, { recursive: true });
    const live = new Set(full.map((r) => r.id));
    for (const entry of fs.readdirSync(extraTemplatesDir))
      if (!live.has(entry))
        fs.rmSync(path.join(extraTemplatesDir, entry), {
          recursive: true,
          force: true,
        });
    for (const row of full) {
      try {
        await materialise(row);
      } catch (e) {
        console.error(
          `[studio] could not prepare uploaded design ${row.id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    // Occasions come from the shipped folder: an upload names one of them.
    const registry = createTemplateRegistry({
      templatesDir: TEMPLATES_DIR,
      assetsDir: ASSETS_DIR,
      extraTemplatesDir,
    });
    for (const p of registry.problems())
      console.warn(`[studio] design excluded ${p.folder}: ${p.message}`);
    cached = { stamp, registry };
    return registry;
  })();
  /* Cleared only after the assignment: with no uploads the build has nothing
     to await and settles at once, and a `finally` inside it would clear
     `building` before it was ever set — leaving a stale promise for good. */
  building = build;
  void build
    .finally(() => {
      if (building === build) building = null;
    })
    .catch(() => undefined);
  return build;
}

/** The shipped designs alone — for a sample render that must not wait on the database. */
let shipped: TemplateRegistry | null = null;
export function shippedRegistry(): TemplateRegistry {
  shipped ??= createTemplateRegistry({
    templatesDir: TEMPLATES_DIR,
    assetsDir: ASSETS_DIR,
  });
  return shipped;
}
