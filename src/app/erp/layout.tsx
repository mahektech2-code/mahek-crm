import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { isErpAdministrator, requireErpApp } from "@/lib/erp/access";
import { erpPreviewTargets } from "@/lib/services/erp-designation-service";
import { ERP_GROUPS, erpHref, erpKeysOf } from "@/lib/erp/registry";
import { erpNavCounts } from "@/lib/erp/counts";
import { getConfig } from "@/lib/config/store";
import { featureState } from "@/lib/erp/ai";
import { listNotifications } from "@/lib/queries";
import { ErpShell, type NavGroup } from "./_ui/erp-shell";

/**
 * The ERP's shell.
 *
 * The grant is checked here as well as on the launcher — a bookmarked /erp must
 * not open for somebody never given it — and the sidebar draws only the screens
 * this person holds. Each screen's page checks its own module again, because a
 * link that is not drawn is a statement to the browser, not a permission.
 */
export default async function ErpLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireErpApp();
  /* The header, the switcher and the bell are always the person SIGNED IN —
     a preview changes whose ERP is drawn, never who is looking at it. */
  const [apps, ownHat, counts, config, askState, notifications, canPreview] = await Promise.all([
    listUserApps(ctx.actor.id),
    hatForHeader(ctx.actor, "erp"),
    erpNavCounts(ctx),
    getConfig(),
    featureState("ask", true),
    listNotifications(ctx.actor.id),
    ctx.viewingAs ? Promise.resolve(true) : isErpAdministrator(ctx.actor),
  ]);
  /* THE DESIGNATION IS THE JOB, so it is what the header says under the name —
     "Owner / CEO", as the design draws it — wherever somebody holds one. */
  const hat = ctx.designation && !ctx.viewingAs ? { ...ownHat, label: ctx.designation } : ownHat;
  const previewTargets = canPreview ? await erpPreviewTargets() : null;

  const nav: NavGroup[] = ERP_GROUPS.map((g) => {
    const screens = g.screens
      .filter((s) => s.built && ctx.screens.has(s.key))
      .map((s) => ({
        key: s.key,
        label: s.label,
        href: erpHref(s),
        /* A screen with tabs carries the work waiting on any of them: the
           Transport screen's badge is its Pending LR count. */
        count: erpKeysOf(s).reduce((n, k) => n + (counts[k] ?? 0), 0),
      }));
    return {
      id: g.id,
      label: g.label,
      icon: g.icon,
      single: screens.length === 1 && (g.screens.length === 1 || g.id === "dashboard" || g.id === "settings"),
      screens,
    };
  }).filter((g) => g.screens.length > 0);

  return (
    <ErpShell
      nav={nav}
      user={{ name: ctx.actor.name, email: ctx.actor.email, phone: ctx.actor.phone, initials: initialsOf(ctx.actor.name), role: ctx.actor.role }}
      hat={hat}
      godowns={ctx.assignedGodowns.map((g) => ({ id: g.id, name: g.name }))}
      working={ctx.workingGodown ? { id: ctx.workingGodown.id, name: ctx.workingGodown.name } : null}
      notifications={notifications}
      voice={config["erp.ai.voice.enabled"]}
      locate={config["erp.location.autoDetect"] && !ctx.viewingAs}
      preview={
        previewTargets
          ? { targets: previewTargets, current: ctx.viewingAs, self: { id: ctx.actor.id, name: ctx.actor.name } }
          : null
      }
      ask={askState.on}
      apps={webApps(apps)}
    >
      {children}
    </ErpShell>
  );
}
