import type {
  catalogueSummary,
  listAliases,
  listDuplicates,
  listExceptions,
  listHierarchy,
  listSkus,
} from "@/lib/services/catalogue-service";
import type { ImportReport } from "@/lib/services/catalogue-import";

/* ---------------------------------------------------------------------------
 * Everything the Catalogue section is handed by the server.
 *
 * The shapes are derived from the read functions rather than restated, so a
 * column added to a query cannot silently fail to reach the screen — and a
 * column removed from one breaks the build instead of rendering "undefined".
 * ------------------------------------------------------------------------- */

type Unwrap<T> = T extends (...args: never[]) => Promise<infer R> ? R : never;

export type CatalogueData = {
  summary: Unwrap<typeof catalogueSummary>;
  skus: Unwrap<typeof listSkus>["rows"];
  total: number;
  page: number;
  pages: number;
  hierarchy: Unwrap<typeof listHierarchy>;
  duplicates: Unwrap<typeof listDuplicates>;
  exceptions: Unwrap<typeof listExceptions>;
  aliases: Unwrap<typeof listAliases>;
  /** What the filter bar is currently set to, so the URL and the screen agree. */
  filters: { query?: string; formulationId?: string; status?: string };
  /** Where a line's price is meant to come from — "unset" blocks valuation. */
  priceSource: string;
  /** Where the source document contradicts its own counts. */
  discrepancies: string[];
  /** Only ever set by running an import in this session. */
  lastReport: ImportReport | null;
};
