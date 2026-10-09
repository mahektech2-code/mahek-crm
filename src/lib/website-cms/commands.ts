import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { websiteContent } from "@/db/schema";
import { err, fromThrown, type Result } from "@/lib/result";
import { gateAnyEdit, gateEdit, gatePublish } from "./access";
import { checkLiveSite, type ConnectionCheck, type LiveRefresh } from "./live-site";
import { isKind, KINDS, type KindKey } from "./kinds";
import { deleteMedia, updateMediaAlt } from "./media-service";
import {
  createItem,
  deleteDraft,
  discardChanges,
  getItem,
  importWebsiteContent,
  moveItem,
  previewFor,
  previewForKind,
  publishPending,
  refreshLive,
  transitionItems,
  updateItem,
  type ImportReport,
  type ItemView,
  type PublishOutcome,
} from "./service";

/* ---------------------------------------------------------------------------
 * THE WEBSITE CMS COMMANDS — every operation a person can ask for, each one
 * checking who is asking BEFORE it touches anything.
 *
 * These are what `lib/actions/website-cms.ts` calls. They live apart from the
 * actions for one reason: a server action cannot run outside a Next request
 * (it revalidates paths), and the permission rules are the part that most needs
 * a test. So the actions are three lines each — call a command, refresh the
 * screens — and everything that matters is here, under test.
 *
 * What arrives from a screen is a URL: `kind` and `id` come as strings no
 * dropdown had to produce. The kind of an EXISTING item is read from its row,
 * never from the caller — somebody holding Products must not be able to edit
 * the menus by sending another kind.
 * ------------------------------------------------------------------------- */

async function kindOfItem(id: unknown): Promise<KindKey | null> {
  if (typeof id !== "string" || !id) return null;
  const [row] = await db.select({ kind: websiteContent.kind }).from(websiteContent).where(eq(websiteContent.id, id)).limit(1);
  return row && isKind(row.kind) ? row.kind : null;
}

const gone = () => err("That item no longer exists.", "not_found");

async function guard<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (e) {
    return fromThrown(e) as Result<T>;
  }
}

/* ------------------------------------------------------------------ editing */

export function createContent(kind: unknown, data: unknown): Promise<Result<ItemView>> {
  return guard(async () => {
    if (!isKind(kind)) return err("That is not something the website holds.", "validation");
    const gate = await gateEdit(kind);
    if (gate.error) return gate.error;
    return createItem(gate.user, kind, data);
  });
}

export function saveContent(id: unknown, data: unknown, expectedVersion?: unknown): Promise<Result<ItemView>> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind);
    if (gate.error) return gate.error;
    return updateItem(gate.user, id as string, data, typeof expectedVersion === "number" ? expectedVersion : undefined);
  });
}

export function discardContentChanges(id: unknown): Promise<Result<ItemView>> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind);
    if (gate.error) return gate.error;
    return discardChanges(gate.user, id as string);
  });
}

export function deleteContentDraft(id: unknown): Promise<Result> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind);
    if (gate.error) return gate.error;
    return deleteDraft(gate.user, id as string);
  });
}

export function moveContent(id: unknown, direction: unknown): Promise<Result> {
  return guard(async () => {
    if (direction !== "up" && direction !== "down") return err("Move up or down.", "validation");
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind);
    if (gate.error) return gate.error;
    return moveItem(gate.user, id as string, direction);
  });
}

/* --------------------------------------------------------------- publishing */

type Action = "publish" | "unpublish" | "archive" | "restore";

export function transitionContent(ids: unknown, action: Action): Promise<Result<PublishOutcome>> {
  return guard(async () => {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some((i) => typeof i !== "string")) {
      return err("Nothing was selected.", "validation");
    }
    // Publishing is its own right, asked for whichever kind is touched…
    const gate = await gatePublish();
    if (gate.error) return gate.error;
    // …and being able to publish does not reach a kind the person cannot edit.
    for (const id of ids as string[]) {
      const kind = await kindOfItem(id);
      if (!kind) return err("One of those items no longer exists.", "not_found");
      const edit = await gateEdit(kind);
      if (edit.error) return edit.error;
    }
    return transitionItems(gate.user, ids as string[], action);
  });
}

export function publishAllPending(kinds?: unknown): Promise<Result<PublishOutcome>> {
  return guard(async () => {
    const gate = await gatePublish();
    if (gate.error) return gate.error;
    const wanted = Array.isArray(kinds) ? kinds.filter(isKind) : undefined;
    const needed = wanted ?? (Object.keys(KINDS) as KindKey[]);
    for (const k of needed) {
      const edit = await gateEdit(k);
      if (edit.error) {
        return wanted
          ? edit.error
          : err("Publishing everything needs access to every Website module. Publish the modules you hold one by one.", "not_permitted");
      }
    }
    return publishPending(gate.user, wanted);
  });
}

export function refreshLiveSiteNow(): Promise<Result<{ live: LiveRefresh }>> {
  return guard(async () => {
    const gate = await gatePublish();
    if (gate.error) return gate.error;
    return refreshLive(gate.user);
  });
}

export function importSiteContent(): Promise<Result<ImportReport>> {
  return guard(async () => {
    const gate = await gatePublish();
    if (gate.error) return gate.error;
    return importWebsiteContent(gate.user);
  });
}

export function checkConnection(): Promise<Result<ConnectionCheck>> {
  return guard(async () => {
    const gate = await gateAnyEdit();
    if (gate.error) return gate.error;
    return { ok: true, data: await checkLiveSite() };
  });
}

/* ------------------------------------------------------------------ preview */

export function previewItem(id: unknown): Promise<Result<{ url: string }>> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind);
    if (gate.error) return gate.error;
    return previewFor(id as string);
  });
}

export function previewKind(kind: unknown, path?: unknown): Promise<Result<{ url: string }>> {
  return guard(async () => {
    if (!isKind(kind)) return err("That is not something the website holds.", "validation");
    const gate = await gateEdit(kind);
    if (gate.error) return gate.error;
    return previewForKind(kind, typeof path === "string" ? path : undefined);
  });
}

/* -------------------------------------------------------------------- media */

export function setMediaAlt(id: unknown, alt: unknown): Promise<Result> {
  return guard(async () => {
    const gate = await gateAnyEdit();
    if (gate.error) return gate.error;
    return updateMediaAlt(String(id), String(alt ?? ""));
  });
}

export function removeMedia(id: unknown): Promise<Result> {
  return guard(async () => {
    const gate = await gateAnyEdit();
    if (gate.error) return gate.error;
    return deleteMedia(gate.user, String(id));
  });
}

export function readContent(id: unknown): Promise<Result<ItemView>> {
  return guard(async () => {
    const kind = await kindOfItem(id);
    if (!kind) return gone();
    const gate = await gateEdit(kind);
    if (gate.error) return gate.error;
    const item = await getItem(id as string);
    return item ? { ok: true, data: item } : gone();
  });
}
