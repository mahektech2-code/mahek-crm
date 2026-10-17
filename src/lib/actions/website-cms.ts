"use server";

import { revalidatePath } from "next/cache";
import type { Result } from "@/lib/result";
import type { ConnectionCheck, LiveRefresh } from "@/lib/website-cms/live-site";
import * as cms from "@/lib/website-cms/commands";
import type { ImportReport, ItemView, PublishOutcome } from "@/lib/website-cms/service";

/* ---------------------------------------------------------------------------
 * The Website CMS's server actions — deliberately three lines each: run the
 * command, refresh the Website screens, hand back its answer.
 *
 * Who may do what, what is validated and what is logged all live in
 * `lib/website-cms/commands.ts`, where it is tested without a Next request.
 * ------------------------------------------------------------------------- */

const done = <T>(r: Result<T>): Result<T> => {
  revalidatePath("/website", "layout");
  return r;
};

export async function createContentAction(kind: string, data: unknown): Promise<Result<ItemView>> {
  return done(await cms.createContent(kind, data));
}
export async function saveContentAction(id: string, data: unknown, expectedVersion?: number): Promise<Result<ItemView>> {
  return done(await cms.saveContent(id, data, expectedVersion));
}
export async function discardChangesAction(id: string): Promise<Result<ItemView>> {
  return done(await cms.discardContentChanges(id));
}
export async function deleteDraftAction(id: string): Promise<Result> {
  return done(await cms.deleteContentDraft(id));
}
export async function moveContentAction(id: string, direction: string): Promise<Result> {
  return done(await cms.moveContent(id, direction));
}

export async function publishItemsAction(ids: string[]): Promise<Result<PublishOutcome>> {
  return done(await cms.transitionContent(ids, "publish"));
}
export async function unpublishItemAction(id: string): Promise<Result<PublishOutcome>> {
  return done(await cms.transitionContent([id], "unpublish"));
}
export async function archiveItemAction(id: string): Promise<Result<PublishOutcome>> {
  return done(await cms.transitionContent([id], "archive"));
}
export async function restoreItemAction(id: string): Promise<Result<PublishOutcome>> {
  return done(await cms.transitionContent([id], "restore"));
}
export async function publishPendingAction(kinds?: string[]): Promise<Result<PublishOutcome>> {
  return done(await cms.publishAllPending(kinds));
}
export async function refreshLiveSiteAction(): Promise<Result<{ live: LiveRefresh }>> {
  return done(await cms.refreshLiveSiteNow());
}
export async function importContentAction(): Promise<Result<ImportReport>> {
  return done(await cms.importSiteContent());
}
export async function checkConnectionAction(): Promise<Result<ConnectionCheck>> {
  return cms.checkConnection();
}

export async function previewItemAction(id: string): Promise<Result<{ url: string }>> {
  return cms.previewItem(id);
}
export async function previewKindAction(kind: string, path?: string): Promise<Result<{ url: string }>> {
  return cms.previewKind(kind, path);
}

export async function updateMediaAltAction(id: string, alt: string): Promise<Result> {
  return done(await cms.setMediaAlt(id, alt));
}
export async function deleteMediaAction(id: string): Promise<Result> {
  return done(await cms.removeMedia(id));
}
export async function getContentAction(id: string): Promise<Result<ItemView>> {
  return cms.readContent(id);
}
