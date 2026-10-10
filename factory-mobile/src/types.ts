/* Who is signed in, as the server's factory actions describe it
   (src/lib/actions/factory.ts). Restated here because that file is a server
   module; the shapes are the wire contract. */
import type { Area, Proc } from "@/lib/factory/types";
import type { Lang } from "@/lib/factory/i18n";

export type Me = { key: string; n: string; ini: string; head: boolean; area: Area; lang: Lang; scope?: Proc | null };
export type Who = { key: string; n: string; ini: string; ph: string; hasPin: boolean };
