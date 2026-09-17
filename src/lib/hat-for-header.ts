import "server-only";
import { levelInApp } from "./access-control";
import { getApp, type AppId } from "./apps";
import { hatSentence, levelLabel } from "./hat-labels";

/**
 * The hat for ONE app, ready for a header, in one call.
 *
 * Every layout needs the same three things — the level for its own app, the
 * word for it and the sentence behind the word — and a layout that assembled
 * them itself is a layout that can assemble them slightly differently. This is
 * the only place they are put together.
 */
export async function hatForHeader(
  user: { id: string; role: string },
  app: AppId,
): Promise<{ label: string; sentence: string }> {
  const level = await levelInApp(user, app);
  return {
    label: levelLabel(level),
    sentence: hatSentence(level, app, getApp(app)?.name ?? app),
  };
}
