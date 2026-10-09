import "server-only";
import type { ComponentType } from "react";
import type { DocTab } from "./registry";

/* ---------------------------------------------------------------------------
 * Where each written tab's MDX is. The ONE file that knows.
 *
 * A literal map of static imports rather than a template string, because the
 * bundler has to see every path to compile it — `import(\`./${x}.mdx\`)` would
 * either pull in every file under the folder or none. `coverage.test.ts`
 * checks this map against `registry.ts` in both directions, so a tab marked
 * written with no content, or content no page claims, fails the build.
 * ------------------------------------------------------------------------- */

type Loader = () => Promise<{ default: ComponentType }>;

export const CONTENT: Record<string, Loader> = {};

export function contentKey(app: string, slug: string, tab: DocTab): string {
  return `${app}/${slug}/${tab}`;
}

export async function loadContent(app: string, slug: string, tab: DocTab): Promise<ComponentType | null> {
  const load = CONTENT[contentKey(app, slug, tab)];
  return load ? (await load()).default : null;
}
