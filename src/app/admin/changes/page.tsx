import Link from "next/link";
import { Badge, Card, EmptyState, Td, Th } from "@/components/ui/primitives";
import { ADMIN } from "@/lib/admin-routes";
import { nowMs, stamp } from "@/lib/format";
import { configChanges, valueLine } from "@/lib/services/admin-console-service";
import { AdminPage } from "../_shell/admin-page";
import { adminContext, requirePlatformAdmin } from "../_shell/context";
import { RestoreButton } from "./restore-button";

/**
 * CHANGE HISTORY — every configuration change, the value before beside the
 * value after.
 *
 * Read off the audit rows the settings writer already keeps, one per setting
 * per save. Restore writes the earlier value back through the same writer, so
 * a restore is itself a change in this list — nothing is rewritten in place.
 * It is offered only on a setting's newest change: restoring an older one
 * would undo every change made since, silently.
 */
export default async function ChangesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePlatformAdmin();
  const ctx = await adminContext();
  const { q } = await searchParams;
  const changes = await configChanges({ q });

  const people = new Set(changes.map((c) => c.actor ?? "—")).size;
  const settings = new Set(changes.map((c) => c.key)).size;
  const now = nowMs();
  const sevenDays = changes.filter((c) => now - c.at.getTime() < 7 * 86_400_000).length;

  return (
    <AdminPage
      title="Change history"
      subtitle="Every setting change, old value beside new. Restore writes the earlier value back and is itself recorded."
      metrics={[
        { label: "Changes shown", value: String(changes.length) },
        { label: "Last 7 days", value: String(sevenDays) },
        { label: "Settings touched", value: String(settings) },
        { label: "People", value: String(people) },
      ]}
      actions={
        <form className="flex items-center gap-2">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Setting key or person"
            aria-label="Find a change"
            className="ui-control h-9 w-64 rounded-control border border-line bg-surface px-3 text-sm text-ink"
          />
        </form>
      }
    >
      <Card className="overflow-hidden">
        {changes.length === 0 ? (
          <EmptyState title="No setting has been changed" />
        ) : (
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Setting</Th>
                  <Th>Before</Th>
                  <Th>After</Th>
                  <Th>By</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id} className="border-b border-divider">
                    <Td className="text-muted">{stamp(c.at)}</Td>
                    <Td className="whitespace-normal">
                      <div className="font-semibold text-ink">{c.label}</div>
                      <div className="font-mono text-xs text-muted">{c.key}</div>
                    </Td>
                    <Td>
                      <span className="rounded-[5px] bg-danger-soft px-2 py-0.5 text-danger line-through">
                        {valueLine(c.before)}
                      </span>
                    </Td>
                    <Td>
                      <span className="rounded-[5px] bg-success-soft px-2 py-0.5 font-semibold text-success">
                        {valueLine(c.after)}
                      </span>
                    </Td>
                    <Td>{c.actor ?? "—"}</Td>
                    <Td align="right">
                      {c.isLatest && c.restorable && ctx.canWriteConfig && c.before !== undefined ? (
                        <RestoreButton settingKey={c.key} value={c.before} label={valueLine(c.before)} />
                      ) : c.isLatest ? null : (
                        <Badge tone="muted">Superseded</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="mt-3 text-[13px] text-muted">
        Settings are edited on <Link href={ADMIN.settings}>Settings</Link>.
      </div>
    </AdminPage>
  );
}
