/* ---------------------------------------------------------------------------
 * WHICH WORKSPACE IS DRAWING THE SALES MANAGER SCREENS, and where its links go.
 *
 * The same dashboard, funnel, list and record are mounted twice: on the Sales
 * Dashboard at `/sales-lead-pipeline`, and in the CRM at
 * `/crm/leads/sales-manager`. What differs is only WHERE a link leads — each
 * app sends the manager to its own intake, qualification and full record, all
 * of which already exist on both sides — so the screens take a workspace and
 * ask this file rather than spelling a route.
 *
 * PURE and client-safe, like `lib/lead-workspace.ts` beside it. The default is
 * `sales`, deliberately: a screen that is handed nothing behaves exactly as it
 * did before the CRM mounted it.
 * ------------------------------------------------------------------------- */

export type PipelineWorkspace = "sales" | "crm";

export type PipelineLinks = {
  /** The workspace's own root — dashboard, `/pipeline`, `/list`, `/[id]` hang off it. */
  base: string;
  /** Raising a lead. */
  intake: string;
  /** The prospect verification / qualification queue. */
  qualify: string;
  /** The app's full lead record, for what this workspace does not draw. */
  record: (id: string) => string;
};

export function pipelineLinks(workspace: PipelineWorkspace = "sales"): PipelineLinks {
  if (workspace === "crm") {
    return {
      base: "/crm/leads/sales-manager",
      intake: "/crm/leads/intake",
      qualify: "/crm/leads/qualify",
      record: (id) => `/crm/leads/${id}`,
    };
  }
  return {
    base: "/sales-lead-pipeline",
    intake: "/sales/leads/intake",
    qualify: "/sales/leads/qualify",
    record: (id) => `/sales/leads/${id}`,
  };
}
