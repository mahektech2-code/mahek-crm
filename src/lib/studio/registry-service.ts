import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { studioDesignVersions, studioDesigns } from "@/db/schema";
import { fileStorage } from "@/lib/storage";
import { ASSETS_DIR, TEMPLATES_DIR } from "./paths";
import { loadTemplateFolder } from "./templates/loader";
import {
  createTemplateRegistry,
  type TemplateRegistry,
} from "./templates/registry";

/* ---------------------------------------------------------------------------
 * THE ONE REGISTRY OF DESIGNS: the approved folders shipped in studio/templates
 * plus every uploaded design somebody has published.
 *
 * The renderer and the loader read FILES — a template is a folder with a
 * template.json, a copy.json, a background and a preview — and that is the
 * format the standalone Studio proved, so an uploaded design is written out as
 * exactly that folder under the OS temp directory and read by the same loader.
 * The database rows and file storage stay the truth; the folder is a cache that
 * a restart, a second process or a wiped /tmp rebuilds from them.
 *
 * What is read, and as what:
 *  - a PUBLISHED design is its own folder, listed and offered for new posters;
 *  - an ARCHIVED design is read as an archived copy of its version;
 *  - every SUPERSEDED version of a design (studio_design_versions) is read the
 *    same way, so a poster made from 1.0.0 draws the same after the design has
 *    moved to 1.0.1.
 * An archived copy is never listed and never offered for a new poster; it is
 * there so what was already made still draws.
 *
 * The registry is rebuilt only when that set changes — `stamp` is every id,
 * version and status — because loading validates every folder and reading
 * backgrounds on every request would be wasted work. A build that could not
 * write every folder is NEVER cached: the next request tries again, so a
 * moment of trouble with file storage costs one request and not a design that
 * is missing until the next restart.
 * ------------------------------------------------------------------------- */

const UPLOADED_ROOT = path.join(os.tmpdir(), "mahek-studio-designs");
const APPROVED_ROOT = path.join(UPLOADED_ROOT, "approved");

let cached: { stamp: string; registry: TemplateRegistry; folders: string[] } | null = null;
let building: Promise<{ registry: TemplateRegistry; clean: boolean; stamp: string; folders: string[] }> | null = null;

type DesignRow = {
  id: string;
  version: string;
  status: string;
  manifest: unknown;
  copy: unknown;
  backgroundRef: string;
  previewRef: string | null;
};

/**
 * The folder an uploaded design is read from. A live design is its own id; an
 * ARCHIVED one — or an earlier version — is read as an archived copy of its
 * version, "<id>-v<version>", the shape the shipped earlier versions already
 * use.
 */
export function folderFor(row: Pick<DesignRow, "id" | "version" | "status">): string {
  return row.status === "archived"
    ? `${row.id}-v${row.version.replace(/\./g, "-")}`
    : row.id;
}

/** The manifest as the loader should read it: an archived design names itself as the version of its own id. */
function manifestFor(row: DesignRow): unknown {
  if (row.status !== "archived") return row.manifest;
  const m = (row.manifest ?? {}) as Record<string, unknown>;
  return { ...m, id: folderFor(row), versionOf: row.id, status: "archived" };
}

/**
 * Writes one design's folder. The files go into a temporary folder that is
 * renamed into place, so a request that loads the registry while another is
 * writing never sees half a design. The folder is a CACHE: the row and the
 * stored files are the truth and a missing folder is rebuilt from them.
 */
async function materialise(row: DesignRow): Promise<void> {
  const name = folderFor(row);
  const dir = path.join(APPROVED_ROOT, name);
  const marker = path.join(dir, ".version");
  const stamp = `${row.version}|${row.status}`;
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === stamp)
    return;
  const [background, preview] = await Promise.all([
    fileStorage.read(row.backgroundRef),
    row.previewRef ? fileStorage.read(row.previewRef) : null,
  ]);
  const tmp = path.join(APPROVED_ROOT, `.tmp-${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(tmp, "template.json"),
      JSON.stringify(manifestFor(row), null, 2),
    );
    fs.writeFileSync(
      path.join(tmp, "copy.json"),
      JSON.stringify(row.copy ?? {}, null, 2),
    );
    fs.writeFileSync(path.join(tmp, "background.png"), Buffer.from(background));
    if (preview)
      fs.writeFileSync(path.join(tmp, "preview.png"), Buffer.from(preview));
    fs.writeFileSync(path.join(tmp, ".version"), stamp);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

const LIVE = ["approved", "archived"];

/** Every uploaded design and earlier version, as the rows the registry is built from. */
async function readRows(): Promise<{ stampRows: string[]; load: () => Promise<DesignRow[]> }> {
  const [designs, versions] = await Promise.all([
    db
      .select({ id: studioDesigns.id, version: studioDesigns.version, status: studioDesigns.status })
      .from(studioDesigns)
      .where(inArray(studioDesigns.status, LIVE)),
    db.select({ id: studioDesignVersions.designId, version: studioDesignVersions.version }).from(studioDesignVersions),
  ]);
  const stampRows = [
    ...designs.map((r) => `${r.id}@${r.version}@${r.status}`),
    ...versions.map((r) => `${r.id}@${r.version}@earlier`),
  ].sort();
  const load = async (): Promise<DesignRow[]> => {
    const [d, v] = await Promise.all([
      designs.length
        ? db
            .select({
              id: studioDesigns.id,
              version: studioDesigns.version,
              status: studioDesigns.status,
              manifest: studioDesigns.manifest,
              copy: studioDesigns.copy,
              backgroundRef: studioDesigns.backgroundRef,
              previewRef: studioDesigns.previewRef,
            })
            .from(studioDesigns)
            .where(inArray(studioDesigns.status, LIVE))
        : [],
      versions.length ? db.select().from(studioDesignVersions) : [],
    ]);
    return [
      ...d,
      ...v.map((r) => ({ id: r.designId, version: r.version, status: "archived", manifest: r.manifest, copy: r.copy, backgroundRef: r.backgroundRef, previewRef: r.previewRef })),
    ];
  };
  return { stampRows, load };
}

/** True while every folder this registry was built from is still on disk — a wiped /tmp must not leave a registry pointing at nothing. */
function foldersPresent(folders: readonly string[]): boolean {
  return folders.every((f) => fs.existsSync(path.join(APPROVED_ROOT, f, ".version")));
}

/**
 * The designs as they stand now. The rows are read on every call (a handful
 * of short rows), and the folders are only written the first time a design is
 * seen by this process, or again after they went missing.
 */
export async function getStudioRegistry(): Promise<TemplateRegistry> {
  const { stampRows, load } = await readRows();
  const stamp = stampRows.join("|");
  if (cached && cached.stamp === stamp && foldersPresent(cached.folders)) return cached.registry;
  if (building) {
    const shared = await building;
    if (shared.stamp === stamp) return shared.registry;
  }
  const build = (async () => {
    const full = await load();
    fs.mkdirSync(APPROVED_ROOT, { recursive: true });
    const folders = full.map((r) => folderFor(r));
    const live = new Set(folders);
    for (const entry of fs.readdirSync(APPROVED_ROOT))
      if (!live.has(entry) && !entry.startsWith(".tmp-"))
        fs.rmSync(path.join(APPROVED_ROOT, entry), {
          recursive: true,
          force: true,
        });
    let clean = true;
    for (const row of full) {
      try {
        await materialise(row);
      } catch (e) {
        clean = false;
        console.error(
          `[studio] could not prepare uploaded design ${row.id}@${row.version}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    // Occasions come from the shipped folder: an upload names one of them.
    const registry = createTemplateRegistry({
      templatesDir: TEMPLATES_DIR,
      assetsDir: ASSETS_DIR,
      extraTemplatesDir: APPROVED_ROOT,
    });
    for (const p of registry.problems())
      console.warn(`[studio] design excluded ${p.folder}: ${p.message}`);
    /* Only a build that wrote every folder is remembered. One that could not —
       file storage unreachable for a moment — answers this request and is
       thrown away, so the next request tries again. */
    if (clean) cached = { stamp, registry, folders };
    else cached = null;
    return { registry, clean, stamp, folders };
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
  return (await build).registry;
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

/**
 * THE GATE BEFORE ANYTHING IS PUBLISHED: writes the candidate as the folder it
 * would be and runs the SAME validation the registry loader runs on every
 * design it reads — manifest schema, fonts that cover each declared language,
 * a copy entry for every declared language and every line of copy checked,
 * customer wording, a background of exactly the canvas size, a preview. What
 * this refuses, the registry would exclude; so a design that passes can never
 * be approved and then silently vanish from the library. Returns the problems,
 * empty when it would load.
 */
export function validateCandidate(input: { manifest: { id: string }; copy: unknown; background: Buffer; preview: Buffer }): string[] {
  const shippedReg = shippedRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mahek-studio-candidate-"));
  try {
    const dir = path.join(root, input.manifest.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify(input.manifest, null, 2));
    fs.writeFileSync(path.join(dir, "copy.json"), JSON.stringify(input.copy ?? {}, null, 2));
    fs.writeFileSync(path.join(dir, "background.png"), input.background);
    fs.writeFileSync(path.join(dir, "preview.png"), input.preview);
    const result = loadTemplateFolder(dir, { templatesDir: TEMPLATES_DIR, assetsDir: ASSETS_DIR, fonts: shippedReg.fonts, occasions: shippedReg.occasions() });
    return result.template ? [] : result.problems;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
