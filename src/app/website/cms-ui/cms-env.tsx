"use client";

import * as React from "react";
import type { MediaView } from "@/lib/website-cms/media-service";

/* ---------------------------------------------------------------------------
 * What every Website editor needs to know about its surroundings: the image
 * library (so a field can offer it), the public site's address (so a picture
 * that lives on the public site can be previewed here), and the catalogue (so an
 * industry can say which products sit under it).
 *
 * Handed down once by the server page, so no field fetches anything by itself.
 * ------------------------------------------------------------------------- */

export type ProductOption = { slug: string; name: string };

type Env = {
  media: MediaView[];
  addMedia: (m: MediaView) => void;
  siteUrl: string;
  products: ProductOption[];
};

const CmsEnvContext = React.createContext<Env | null>(null);

export function CmsEnvProvider({
  media: initial,
  siteUrl,
  products,
  children,
}: {
  media: MediaView[];
  siteUrl: string;
  products: ProductOption[];
  children: React.ReactNode;
}) {
  // What the server last sent, plus anything uploaded since — which the next refresh
  // will include, at which point the duplicate is dropped by id.
  const [added, setAdded] = React.useState<MediaView[]>([]);
  const media = React.useMemo(() => [...added.filter((a) => !initial.some((i) => i.id === a.id)), ...initial], [added, initial]);
  const addMedia = React.useCallback((m: MediaView) => setAdded((all) => (all.some((x) => x.id === m.id) ? all : [m, ...all])), []);
  const value = React.useMemo(() => ({ media, addMedia, siteUrl, products }), [media, addMedia, siteUrl, products]);
  return <CmsEnvContext.Provider value={value}>{children}</CmsEnvContext.Provider>;
}

export function useCmsEnv(): Env {
  const env = React.useContext(CmsEnvContext);
  if (!env) throw new Error("useCmsEnv must be used inside <CmsEnvProvider>");
  return env;
}

/**
 * Where to load a picture from INSIDE MahekOne. An uploaded file is served to
 * signed-in editors by MahekOne itself; a file that ships with the public site
 * is loaded from the public site; anything else is already a full address.
 */
export function thumbUrl(url: string, siteUrl: string): string {
  const upload = /^\/cms-media\/([A-Za-z0-9_-]{8,64})\//.exec(url);
  if (upload) return `/api/website/media/${upload[1]}`;
  if (url.startsWith("/") && !url.startsWith("//")) return `${siteUrl}${url}`;
  return url;
}
