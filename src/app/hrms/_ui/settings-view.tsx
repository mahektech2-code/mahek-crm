import Link from "next/link";
import { getConfig } from "@/lib/config/store";
import { hrmsSchema } from "@/lib/config/schema-contract";
import type { Config } from "@/lib/config/registry";
import { ADMIN } from "@/lib/admin-routes";

/**
 * HRMS settings are edited in ONE place, the Admin Console's HRMS section —
 * the same audited writer every other setting goes through. This tab reads
 * the values in force and says where they are changed, rather than being a
 * second editor that could drift from the first.
 *
 * It used to send a platform admin straight to the console. Now that it is a
 * tab beside the pick lists, that would have made the pick lists unreachable
 * for exactly the people who maintain them, so everybody reads it here and the
 * console is a link away.
 */
export async function SettingsView() {
  const config = await getConfig();
  const schema = hrmsSchema();
  return (
    <div className="grid gap-4">
      <div className="rounded-[6px] border border-line bg-surface px-4 py-3 text-[13px] text-body">
        These are the rules HRMS runs on. An administrator changes them in the{" "}
        <Link href={ADMIN.settingsFor("hrms")}>Admin Console</Link>, where every change is recorded.
      </div>
      {schema.tabs.map((t) => (
        <section key={t.key} className="rounded-[8px] border border-line bg-surface">
          <div className="border-b border-line px-5 py-3 text-[15px] font-semibold text-ink">{t.label}</div>
          {t.groups.map((g) => (
            <div key={g.label} className="px-5 py-3">
              <div className="text-[12px] font-medium uppercase tracking-[0.04em] text-muted">{g.label}</div>
              <dl className="mt-2 grid gap-2">
                {g.fields.map((f) => (
                  <div key={f.key} className="flex flex-wrap justify-between gap-2 text-[13px]">
                    <dt className="text-body">{f.label}</dt>
                    <dd className="font-medium text-ink">{show(config[f.key as keyof Config])}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function show(v: unknown): string {
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (v == null || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
