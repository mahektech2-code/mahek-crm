import Link from "next/link";
import { redirect } from "next/navigation";
import { hrmsContext } from "@/lib/hrms/access";
import { getConfig } from "@/lib/config/store";
import { hrmsSchema } from "@/lib/config/schema-contract";
import type { Config } from "@/lib/config/registry";
import { isPlatformAdmin } from "@/lib/access-control";
import { ADMIN } from "@/lib/admin-routes";

export const dynamic = "force-dynamic";
export const metadata = { title: "HRMS settings — MahekOne" };

/**
 * HRMS settings are edited in ONE place, the Admin Console's HRMS section —
 * the same audited writer every other setting goes through. Somebody who can
 * open the console is taken there; anybody else holding this screen reads the
 * values in force and who changes them, rather than a second editor that could
 * drift from the first.
 */
export default async function HrmsSettings() {
  const ctx = await hrmsContext();
  if (!ctx.screens.has("settings")) redirect("/hrms");
  if (await isPlatformAdmin(ctx.user)) redirect(ADMIN.settingsFor("hrms"));
  const config = await getConfig();
  const schema = hrmsSchema();
  return (
    <div className="grid gap-4">
      <div className="rounded-[6px] border border-line bg-surface px-4 py-3 text-[13px] text-body">
        These are the rules HRMS runs on. They are changed by an administrator in the{" "}
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
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
