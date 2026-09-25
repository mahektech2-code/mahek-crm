import { listTemplates } from "@/lib/services/whatsapp-service";
import {
  automationSettings,
  listRules,
  recentRuns,
  sendsPerRule,
  type RunSummary,
} from "@/lib/services/whatsapp-automation-service";
import { whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import { specFor, specKey } from "@/lib/wati-templates";
import { AutomationControl } from "./automation-control";

export const metadata = { title: "WhatsApp automation - Founder Dashboard - MahekOne" };

/**
 * The founder's rules for sending the eight WhatsApp templates on their own:
 * when each fires, how often, how many times, and the hours anything may go.
 */
export default async function Page() {
  const [settings, rules, runs, counts, templates, service] = await Promise.all([
    automationSettings(),
    listRules(),
    recentRuns(12),
    sendsPerRule(7),
    listTemplates(),
    whatsappServiceState(),
  ]);

  return (
    <AutomationControl
      settings={settings}
      serviceOn={service.active}
      rules={rules.map((r) => ({
        id: r.id,
        templateId: r.templateId,
        templateName: r.templateName,
        linked: Boolean(r.watiTemplateName),
        kind: r.kind,
        status: r.status,
        fromDay: r.fromDay,
        toDay: r.toDay,
        repeatEveryDays: r.repeatEveryDays,
        maxSends: r.maxSends,
        minAmountPaise: r.minAmountPaise,
        priority: r.priority,
        updatedByName: r.updatedByName,
        updatedAt: r.updatedAt.toISOString(),
        sentLast7: counts[r.id] ?? 0,
      }))}
      templates={templates
        .map((t) => {
          const spec = specFor(t.watiSpec ?? specKey(t.watiTemplateName));
          return spec ? { id: t.id, name: t.name, kind: spec.kind, linked: Boolean(t.watiTemplateName) } : null;
        })
        .filter((t): t is NonNullable<typeof t> => t !== null)}
      runs={runs.map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        source: r.trigger,
        note: r.note,
        summary: r.summary as RunSummary,
      }))}
    />
  );
}
