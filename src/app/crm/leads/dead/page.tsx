/*
 * DEAD LEADS — Lost leads a reporting manager approved as permanently Dead.
 *
 * Three views of one thing, and the page never widens what somebody may read:
 *   • the Dead list (approved only), for whoever holds `crm.lead-dead`;
 *   • the approval queue — requests routed to THIS person by the Org Chart,
 *     and nobody else's;
 *   • this person's own requests, asked or assigned, rejections included.
 *
 * Nothing here writes. Approving and rejecting go through `decideDeadRequest`,
 * which checks the request names the caller as its approver.
 */
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import {
  DEAD_LEADS_PER_PAGE,
  deadLeadsPage,
  deadQueueFor,
  deadRequestHistoryFor,
} from "@/lib/services/lead-dead-service";
import { DeadLeadsScreen } from "@/components/leads/dead/dead-leads-screen";

export const metadata = { title: "Dead Leads — Lead Management — CRM — MahekOne" };
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const [holdsModule, config, queue, mine] = await Promise.all([
    canOpenModule(user.id, "crm.lead-dead"),
    getConfig(),
    deadQueueFor(user.id),
    deadRequestHistoryFor(user.id),
  ]);

  const list = holdsModule
    ? await deadLeadsPage({
        search: params.q?.slice(0, 200),
        page: Number(params.page) || 1,
        perPage: Number(params.per) || DEAD_LEADS_PER_PAGE,
      })
    : null;

  const wanted = params.tab;
  const tab =
    wanted === "list" && list ? "list" : wanted === "mine" ? "mine" : wanted === "queue" ? "queue" : queue.length ? "queue" : list ? "list" : "mine";

  return (
    <DeadLeadsScreen
      viewerId={user.id}
      tab={tab}
      list={list}
      queue={queue}
      mine={mine}
      reasons={config["leads.deadReasons"].map((r) => ({ code: r.code, label: r.label }))}
    />
  );
}
