"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { saveFieldSettings } from "@/lib/actions/sales";
import type { FieldSetting } from "@/lib/services/sales-service";
import { Banner, Button, Pill, ScreenHeader, plural } from "../parts";

type Group = { category: string; label: string; blurb: string; settings: FieldSetting[] };

/**
 * The numbers the handsets read.
 *
 * Nothing business-critical in MahekOne is a constant, and none of these is an
 * exception — they live in `app_settings` and are written through the same
 * audited store the Admin Console uses, so a change made here carries the same
 * before-and-after row and the same cross-setting consistency check.
 *
 * What it does NOT do is push anything. A handset reads configuration on its
 * ordinary pull, so a change reaches a salesman when his phone next has signal
 * — which on this app is the honest thing to say rather than "applied".
 *
 * Only `mbos.*` keys appear, and the action refuses anything else: a sales
 * manager is not handed the whole of MahekOne's configuration because their app
 * happens to have a settings page.
 */
export function SettingsScreen({ groups }: { groups: Group[] }) {
  const router = useRouter();
  const toast = useToast();

  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [warnings, setWarnings] = React.useState<string[]>([]);

  const all = groups.flatMap((g) => g.settings);
  const byKey = new Map(all.map((s) => [s.key, s]));

  const dirty = Object.entries(drafts).filter(([key, raw]) => {
    const s = byKey.get(key);
    return s ? raw !== asText(s.value) : false;
  });

  function set(key: string, raw: string) {
    setDrafts((d) => ({ ...d, [key]: raw }));
    setFieldErrors((f) => {
      if (!(key in f)) return f;
      const next = { ...f };
      delete next[key];
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setWarnings([]);

    const entries: Array<{ key: string; value: unknown }> = [];
    for (const [key, raw] of dirty) {
      const s = byKey.get(key)!;
      const parsed = parse(s, raw);
      if (parsed.ok) entries.push({ key, value: parsed.value });
      else setFieldErrors((f) => ({ ...f, [key]: parsed.error }));
    }

    if (entries.length !== dirty.length) {
      setBusy(false);
      setError("Some of those values could not be read. The ones marked below need fixing.");
      return;
    }

    let result;
    try {
      result = await saveFieldSettings(entries);
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setBusy(false);
    }

    if (!result.ok) {
      setError(result.error);
      for (const f of result.fieldErrors ?? []) {
        setFieldErrors((prev) => ({ ...prev, [f.field]: f.message }));
      }
      return;
    }

    setDrafts({});
    setWarnings(result.data.warnings);
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  return (
    <div className="p-6">
      <ScreenHeader
        title="Field settings"
        subtitle="The thresholds every handset reads. They are stored, audited and versioned like every other setting in MahekOne — a change here reaches a salesman on his next sync, not the moment you press save."
        actions={
          <>
            <Button
              tone="quiet"
              disabled={busy || dirty.length === 0}
              onClick={() => {
                setDrafts({});
                setFieldErrors({});
                setError(null);
              }}
            >
              Discard
            </Button>
            <Button
              tone="primary"
              disabled={busy || dirty.length === 0}
              title={dirty.length === 0 ? "Nothing has been changed." : undefined}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : `Save ${plural(dirty.length, "change")}`}
            </Button>
          </>
        }
      />

      {error ? <Banner tone="danger" title="That did not save" body={error} /> : null}

      {warnings.length ? (
        <Banner
          tone="warn"
          title="Saved, with something worth knowing"
          body={
            <ul className="list-disc pl-4">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g.category} className="rounded-[6px] border border-line bg-surface">
            <header className="border-b border-line px-5 py-3">
              <h2 className="text-[15px] font-semibold text-ink">{g.label}</h2>
              <p className="mt-0.5 max-w-[760px] text-[13px] text-pretty text-muted">{g.blurb}</p>
            </header>

            <div className="divide-y divide-divider">
              {g.settings.map((s) => {
                const raw = drafts[s.key] ?? asText(s.value);
                const changed = raw !== asText(s.value);
                const problem = fieldErrors[s.key];

                return (
                  <div
                    key={s.key}
                    className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-6 px-5 py-3.5"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-ink">{s.label}</span>
                        {changed ? <Pill tone="brand">Changed</Pill> : null}
                        {!changed && !s.isDefault ? <Pill>Set</Pill> : null}
                      </div>
                      <p className="mt-0.5 text-[13px] text-pretty text-muted">{s.description}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted">{s.key}</p>
                      {problem ? (
                        <p className="mt-1 text-[13px] text-danger">{problem}</p>
                      ) : null}
                    </div>

                    <div className="pt-0.5">
                      {s.type === "boolean" ? (
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-body">
                          <input
                            type="checkbox"
                            checked={raw === "true"}
                            onChange={(e) => set(s.key, e.target.checked ? "true" : "false")}
                          />
                          {raw === "true" ? "On" : "Off"}
                        </label>
                      ) : s.options ? (
                        <select
                          value={raw}
                          onChange={(e) => set(s.key, e.target.value)}
                          className="h-8.5 w-full rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
                        >
                          {s.options.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : s.type === "structured" ? (
                        <textarea
                          value={raw}
                          onChange={(e) => set(s.key, e.target.value)}
                          rows={Math.min(8, raw.split("\n").length + 1)}
                          spellCheck={false}
                          className={
                            "w-full rounded-[4px] border bg-surface px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-brand " +
                            (problem ? "border-danger" : "border-line")
                          }
                        />
                      ) : (
                        <input
                          value={raw}
                          onChange={(e) => set(s.key, e.target.value)}
                          inputMode={s.type === "text" ? undefined : "decimal"}
                          className={
                            "h-8.5 w-full rounded-[4px] border bg-surface px-2 text-sm text-ink outline-none focus:border-brand " +
                            (problem ? "border-danger" : "border-line")
                          }
                        />
                      )}
                      {s.min != null || s.max != null ? (
                        <p className="mt-1 text-[11px] text-muted">
                          {s.min != null ? `From ${s.min}` : ""}
                          {s.min != null && s.max != null ? " to " : ""}
                          {s.max != null ? `${s.min == null ? "Up to " : ""}${s.max}` : ""}
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** The stored value as something an input can hold. */
function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * Back the other way, by the setting's own declared type.
 *
 * The server validates all of this again — `updateSettings` is the authority
 * and refuses anything the registry does not accept. This is here so a typo is
 * caught under the field it belongs to rather than as a banner at the top,
 * which sends somebody hunting through forty rows for the one that is wrong.
 */
function parse(
  s: FieldSetting,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (s.type === "boolean") return { ok: true, value: raw === "true" };

  if (s.type === "integer" || s.type === "decimal") {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return { ok: false, error: "That is not a number." };
    if (s.type === "integer" && !Number.isInteger(n)) {
      return { ok: false, error: "A whole number, with no decimal point." };
    }
    return { ok: true, value: n };
  }

  if (s.type === "structured") {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return {
        ok: false,
        error: "That is not readable JSON — check the brackets, commas and quotes.",
      };
    }
  }

  return { ok: true, value: raw };
}
