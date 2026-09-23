import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { secretStatuses } from "@/lib/secrets";
import { appOrigin } from "@/lib/password-reset";
import { currentWebhookToken, listWatiTemplates, watiHealth } from "@/lib/wati";
import { serviceHistory, whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import {
  apiSendCounts,
  listTemplates,
  listUnmatchedReplies,
  MERGE_FIELDS,
} from "@/lib/services/whatsapp-service";
import { WhatsappControl } from "./whatsapp-control";

export const metadata = { title: "WhatsApp - Founder Dashboard - MahekOne" };

/**
 * The founder's WhatsApp desk: the switch, whether the Wati connection works,
 * which approved template each message goes out as, and what has gone.
 *
 * Everything on it is read live — the connection check calls Wati on every
 * load — because this is the screen somebody opens to find out whether
 * messages are going, and a cached "connected" is the one answer that must
 * not be stale.
 */
export default async function Page() {
  const user = await requireUser();
  const [apps, state, history, secrets, health, watiTemplates, crmTemplates, counts, unmatched, token, origin] =
    await Promise.all([
      listUserApps(user.id),
      whatsappServiceState(),
      serviceHistory(20),
      secretStatuses(),
      watiHealth(),
      listWatiTemplates({ fresh: true }),
      listTemplates(),
      apiSendCounts(7),
      listUnmatchedReplies(20),
      currentWebhookToken(),
      appOrigin(),
    ]);

  const key = secrets.find((s) => s.name === "wati.apiToken");

  return (
    <WhatsappControl
      state={{
        active: state.active,
        at: state.at?.toISOString() ?? null,
        byName: state.byName,
        note: state.note,
      }}
      history={history.map((h) => ({
        id: h.id,
        active: h.active,
        note: h.note,
        byName: h.changedByName,
        at: h.at.toISOString(),
      }))}
      keyRow={{
        name: "wati.apiToken",
        source: key?.source ?? "unset",
        last4: key?.last4 ?? null,
        updatedAt: key?.updatedAt?.toISOString() ?? null,
      }}
      canWriteKey={apps.includes("admin")}
      health={health}
      watiTemplates={
        watiTemplates.ok
          ? watiTemplates.templates.map((t) => ({
              name: t.name,
              status: t.status,
              category: t.category,
              language: t.language,
              body: t.body,
              params: t.params,
            }))
          : []
      }
      watiTemplatesError={watiTemplates.ok ? null : watiTemplates.error}
      crmTemplates={crmTemplates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        escalationStage: t.escalationStage,
        body: t.body,
        watiTemplateName: t.watiTemplateName,
      }))}
      mergeFields={[...MERGE_FIELDS]}
      counts={counts}
      unmatchedReplies={unmatched.map((r) => ({
        id: r.id,
        waId: r.waId,
        senderName: r.senderName,
        message: r.message,
        receivedAt: r.receivedAt.toISOString(),
      }))}
      webhookUrl={token ? `${origin}/api/whatsapp/wati/${token}` : null}
    />
  );
}
