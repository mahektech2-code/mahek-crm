"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Field, Input, Select, Td, Textarea, Th } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import {
  BANNER_SCREENS,
  BANNER_TONES,
  validateRemoteItem,
  type BannerValue,
  type RemoteKind,
  type RemotePayload,
} from "@/lib/engines/mbos-remote";
import { deleteRemoteItem, previewRemote, saveRemoteItem, setRemoteItemEnabled } from "@/lib/actions/mbos-remote";

export type ControlRow = {
  key: string;
  kind: RemoteKind;
  value: unknown;
  audience: {
    roles: string[];
    people: string[];
    peopleNames: string[];
    minVersion: string;
    maxVersion: string;
    percent: number;
  };
  enabled: boolean;
  note: string;
  updatedAt: string;
  updatedBy: string | null;
};

const KIND_LABEL: Record<RemoteKind, string> = { flag: "Switch", text: "Sentence", banner: "Banner" };
const ROLES = [
  { id: "associate", label: "Salesmen" },
  { id: "manager", label: "Managers" },
  { id: "admin", label: "Admins" },
];

export function MbosControlSection({ rows }: { rows: ControlRow[] }) {
  const [editing, setEditing] = React.useState<{ row: ControlRow | null; n: number } | null>(null);
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    push(r.ok ? (r.message ?? "Done.") : (r.error ?? "Could not do that."), r.ok ? "info" : "error");
    if (r.ok) router.refresh();
  };

  return (
    <div className="space-y-5">
      <Callout tone="info">
        Every change reaches phones on their next sync. Remove or switch off an item and the phone goes back to what is
        built into the app. Location tracking, punching in and the screens a working day needs cannot be changed or hidden
        from here.
      </Callout>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">On phones now</h2>
        <Button variant="primary" onClick={() => setEditing({ row: null, n: Date.now() })}>
          Add
        </Button>
      </div>

      {editing ? (
        <Editor
          key={editing.n}
          row={editing.row}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState title="Nothing set" body="Phones are running exactly what is built into the app." />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>What it does</Th>
                <Th>Who gets it</Th>
                <Th>Status</Th>
                <Th>Changed</Th>
                <Th>{""}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line align-top">
                  <Td>
                    <div className="font-mono text-[12px] text-ink">{r.key}</div>
                    <div className="text-xs text-muted">{KIND_LABEL[r.kind]}</div>
                  </Td>
                  <Td className="max-w-[320px]">
                    <div className="text-sm text-body">{describe(r)}</div>
                    {r.note ? <div className="mt-1 text-xs text-muted">{r.note}</div> : null}
                  </Td>
                  <Td className="text-sm text-body">{audienceSentence(r.audience)}</Td>
                  <Td>{r.enabled ? <Badge tone="success">On</Badge> : <Badge tone="muted">Off</Badge>}</Td>
                  <Td className="text-xs text-muted whitespace-nowrap">
                    {stamp(r.updatedAt)}
                    {r.updatedBy ? <div>{r.updatedBy}</div> : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setEditing({ row: r, n: Date.now() })}>
                        Edit
                      </Button>
                      <Button size="sm" disabled={busy === r.key} onClick={() => act(r.key, () => setRemoteItemEnabled(r.key, !r.enabled))}>
                        {r.enabled ? "Switch off" : "Switch on"}
                      </Button>
                      <Button size="sm" variant="danger" disabled={busy === r.key} onClick={() => act(r.key, () => deleteRemoteItem(r.key))}>
                        Remove
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Preview />
    </div>
  );
}

function describe(r: ControlRow): string {
  if (r.kind === "flag") {
    const m = /^menu\.([a-z0-9-]+)\.hidden$/.exec(r.key);
    if (m) return r.value ? `Hides ${m[1]} from the More menu.` : `Shows ${m[1]} in the More menu.`;
    return r.value ? "Switched on." : "Switched off.";
  }
  if (r.kind === "text") return `“${String(r.value)}”`;
  const b = r.value as BannerValue;
  const where = b.screen === "home" ? "Home" : "More";
  const opens = b.route ? `, opens ${b.route}` : b.url ? `, opens a link` : "";
  const window = b.startsAt || b.endsAt ? ` (${b.startsAt ? stamp(b.startsAt) : "now"} to ${b.endsAt ? stamp(b.endsAt) : "no end"})` : "";
  return `On ${where}: “${b.title}”${opens}${window}`;
}

function audienceSentence(a: ControlRow["audience"]): string {
  const parts: string[] = [];
  parts.push(a.roles.length ? ROLES.filter((r) => a.roles.includes(r.id)).map((r) => r.label).join(", ") : "Everybody");
  if (a.peopleNames.length) parts.push(`only ${a.peopleNames.join(", ")}`);
  if (a.minVersion || a.maxVersion) parts.push(`app ${a.minVersion || "any"} to ${a.maxVersion || "newest"}`);
  if (a.percent < 100) parts.push(`${a.percent}% of them`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ editor */

function Editor({ row, onClose, onSaved }: { row: ControlRow | null; onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const banner = (row?.kind === "banner" ? row.value : {}) as Partial<BannerValue>;
  const [kind, setKind] = React.useState<RemoteKind>(row?.kind ?? "banner");
  const [key, setKey] = React.useState(row?.key ?? "banner.");
  const [on, setOn] = React.useState(row?.kind === "flag" ? Boolean(row.value) : true);
  const [text, setText] = React.useState(row?.kind === "text" ? String(row.value) : "");
  const [b, setB] = React.useState({
    screen: banner.screen ?? "home",
    title: banner.title ?? "",
    body: banner.body ?? "",
    imageUrl: banner.imageUrl ?? "",
    tone: banner.tone ?? "info",
    route: banner.route ?? "",
    url: banner.url ?? "",
    order: banner.order != null ? String(banner.order) : "",
    startsAt: toLocalInput(banner.startsAt),
    endsAt: toLocalInput(banner.endsAt),
  });
  const [roles, setRoles] = React.useState<string[]>(row?.audience.roles ?? []);
  const [people, setPeople] = React.useState((row?.audience.people ?? []).join("\n"));
  const [minVersion, setMinVersion] = React.useState(row?.audience.minVersion ?? "");
  const [maxVersion, setMaxVersion] = React.useState(row?.audience.maxVersion ?? "");
  const [percent, setPercent] = React.useState(String(row?.audience.percent ?? 100));
  const [note, setNote] = React.useState(row?.note ?? "");
  const [saving, setSaving] = React.useState(false);

  const value = (): unknown => {
    if (kind === "flag") return on;
    if (kind === "text") return text;
    const v: BannerValue = { screen: b.screen as BannerValue["screen"], title: b.title.trim() };
    if (b.body.trim()) v.body = b.body.trim();
    if (b.imageUrl.trim()) v.imageUrl = b.imageUrl.trim();
    if (b.tone) v.tone = b.tone as BannerValue["tone"];
    if (b.route.trim()) v.route = b.route.trim();
    if (b.url.trim()) v.url = b.url.trim();
    if (b.order.trim()) v.order = Number(b.order);
    if (b.startsAt) v.startsAt = fromLocalInput(b.startsAt);
    if (b.endsAt) v.endsAt = fromLocalInput(b.endsAt);
    return v;
  };

  const audience = { roles, minVersion, maxVersion, percent: Number(percent) || 100 };
  const problems = validateRemoteItem({ key: key.trim(), kind, value: value(), audience });

  const save = async () => {
    setSaving(true);
    const r = await saveRemoteItem({
      key: key.trim(),
      kind,
      value: value(),
      audience,
      people: people.split(/[\n,]/),
      note,
      originalKey: row?.key ?? null,
    });
    setSaving(false);
    push(r.ok ? (r.message ?? "Saved.") : r.error, r.ok ? "info" : "error");
    if (r.ok) onSaved();
  };

  const prefix = kind === "banner" ? "banner." : kind === "text" ? "text." : "feature.";

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-ink">{row ? `Edit ${row.key}` : "Add to phones"}</h3>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Kind">
          <Select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as RemoteKind;
              setKind(k);
              if (!row) setKey(k === "banner" ? "banner." : k === "text" ? "text." : "feature.");
            }}
          >
            <option value="banner">Banner — a card on Home or More</option>
            <option value="text">Sentence — replaces one built into the app</option>
            <option value="flag">Switch — a feature on or off, or a More entry hidden</option>
          </Select>
        </Field>
        <Field
          label="Key"
          hint={`Starts with ${prefix}${kind === "flag" ? " or menu.<screen>.hidden" : ""}. Lower case, dots and dashes.`}
          hintShown
        >
          <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} className="font-mono" />
        </Field>
      </div>

      {kind === "flag" ? (
        <Field label="Value" group>
          <div className="flex gap-4">
            <Checkbox label="On" checked={on} onChange={(e) => setOn(e.target.checked)} />
          </div>
        </Field>
      ) : null}

      {kind === "text" ? (
        <Field label="Sentence" hint="Shown instead of the one built into the app. Remove the item to go back." hintShown>
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      ) : null}

      {kind === "banner" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Screen">
            <Select value={b.screen} onChange={(e) => setB({ ...b, screen: e.target.value as BannerValue["screen"] })}>
              {BANNER_SCREENS.map((s) => (
                <option key={s} value={s}>
                  {s === "home" ? "Home" : "More"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Colour">
            <Select value={b.tone} onChange={(e) => setB({ ...b, tone: e.target.value as BannerValue["tone"] & string })}>
              {BANNER_TONES.map((t) => (
                <option key={t} value={t}>
                  {t === "info" ? "Blue" : t === "success" ? "Green" : "Amber"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title" className="md:col-span-2">
            <Input value={b.title} maxLength={80} onChange={(e) => setB({ ...b, title: e.target.value })} />
          </Field>
          <Field label="Line" optional className="md:col-span-2">
            <Textarea rows={2} value={b.body} maxLength={300} onChange={(e) => setB({ ...b, body: e.target.value })} />
          </Field>
          <Field label="Picture" optional hint="An https:// link to a wide image." hintShown className="md:col-span-2">
            <Input value={b.imageUrl} onChange={(e) => setB({ ...b, imageUrl: e.target.value })} />
          </Field>
          <Field label="Opens a screen" optional hint="catalogue, leads, orders, tasks, performance…" hintShown>
            <Input value={b.route} onChange={(e) => setB({ ...b, route: e.target.value })} className="font-mono" />
          </Field>
          <Field label="Or opens a link" optional hint="https:// only." hintShown>
            <Input value={b.url} onChange={(e) => setB({ ...b, url: e.target.value })} />
          </Field>
          <Field label="Shows from" optional>
            <Input type="datetime-local" value={b.startsAt} onChange={(e) => setB({ ...b, startsAt: e.target.value })} />
          </Field>
          <Field label="Until" optional>
            <Input type="datetime-local" value={b.endsAt} onChange={(e) => setB({ ...b, endsAt: e.target.value })} />
          </Field>
          <Field label="Order" optional hint="Lower shows first." hintShown>
            <Input inputMode="numeric" value={b.order} onChange={(e) => setB({ ...b, order: e.target.value.replace(/[^\d-]/g, "") })} />
          </Field>
        </div>
      ) : null}

      <div className="rounded-control border border-line p-4">
        <div className="mb-3 text-sm font-semibold text-ink">Who gets it</div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Levels" group hint="None ticked means everybody." hintShown>
            <div className="flex flex-wrap gap-4">
              {ROLES.map((r) => (
                <Checkbox
                  key={r.id}
                  label={r.label}
                  checked={roles.includes(r.id)}
                  onChange={(e) => setRoles(e.target.checked ? [...roles, r.id] : roles.filter((x) => x !== r.id))}
                />
              ))}
            </div>
          </Field>
          <Field label="Only these people" optional hint="Emails or work numbers, one a line. Try it on yourself first." hintShown>
            <Textarea rows={2} value={people} onChange={(e) => setPeople(e.target.value)} />
          </Field>
          <Field label="Oldest app" optional hint="e.g. 1.26.0" hintShown>
            <Input value={minVersion} onChange={(e) => setMinVersion(e.target.value)} />
          </Field>
          <Field label="Newest app" optional>
            <Input value={maxVersion} onChange={(e) => setMaxVersion(e.target.value)} />
          </Field>
          <Field label="Share of people (%)" hint="The same people each time. 100 is everybody." hintShown>
            <Input inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </Field>
        </div>
      </div>

      <Field label="Note for the office" optional>
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      {problems.length ? <Callout tone="warn">{problems.join(" ")}</Callout> : null}

      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          disabled={saving || problems.length > 0}
          title={problems.length ? "Fix what is listed above first" : undefined}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}

/** "YYYY-MM-DDTHH:MM" in India's wall clock — the same reading `deadline-gate.tsx` uses. */
function toLocalInput(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms + 330 * 60_000).toISOString().slice(0, 16) : "";
}

function fromLocalInput(v: string): string {
  return new Date(Date.parse(`${v}:00+05:30`)).toISOString();
}

/* ----------------------------------------------------------------- preview */

function Preview() {
  const [who, setWho] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [out, setOut] = React.useState<{ name: string; appVersion: string | null; payload: RemotePayload } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    const r = await previewRemote(who);
    setBusy(false);
    if (r.ok) {
      setOut({ name: r.data.name, appVersion: r.data.who.appVersion, payload: r.data.payload });
      setError(null);
    } else {
      setOut(null);
      setError(r.error);
    }
  };

  const p = out?.payload;
  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-base font-semibold text-ink">What one person&rsquo;s phone gets</h2>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Email or work number" className="min-w-[260px]">
          <Input value={who} onChange={(e) => setWho(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} />
        </Field>
        <Button disabled={busy || !who.trim()} onClick={run}>
          {busy ? "Looking…" : "Show"}
        </Button>
      </div>
      {error ? <Callout tone="warn">{error}</Callout> : null}
      {out && p ? (
        <div className="space-y-2 text-sm text-body">
          <div>
            <strong className="text-ink">{out.name}</strong> · app {out.appVersion ?? "never reported"}
          </div>
          {Object.keys(p.flags).length === 0 && Object.keys(p.texts).length === 0 && p.banners.length === 0 ? (
            <div>Nothing: their phone runs exactly what is built in.</div>
          ) : (
            <ul className="list-disc space-y-1 pl-5">
              {Object.entries(p.flags).map(([k, v]) => (
                <li key={k}>
                  <span className="font-mono text-[12px]">{k}</span> {v ? "on" : "off"}
                </li>
              ))}
              {Object.entries(p.texts).map(([k, v]) => (
                <li key={k}>
                  <span className="font-mono text-[12px]">{k}</span> “{v}”
                </li>
              ))}
              {p.banners.map((x) => (
                <li key={x.id}>
                  Banner on {x.screen === "home" ? "Home" : "More"}: “{x.title}”
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Card>
  );
}
