"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, Checkbox, EmptyState, Field, Input, Select, Textarea, cx } from "@/components/ui/primitives";
import { ConfirmDialog, FilterPills, Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { ADMIN } from "@/lib/admin-routes";
import { getModule } from "@/lib/modules";
import { getApp } from "@/lib/apps";
import { dayLabel } from "@/lib/module-since";
import { powerById } from "@/lib/access-bulk";
import {
  applyAccessTemplate,
  bulkPower,
  bulkScreen,
  deleteAccessTemplate,
  saveAccessTemplate,
  templateFromPerson,
  type BulkOutcome,
} from "@/lib/actions/access-bulk";
import type {
  PowerOverview,
  ScreenOverview,
  TemplateRow,
} from "@/lib/services/access-overview-service";
import type { Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * POWERS & SCREENS — access from the power's side.
 *
 * Three tabs. Powers: every special power of the ERP, HRMS and Tasks, who
 * holds it, who could, and the work waiting on it — a power with a queue and
 * no holder sorts to the top in red. Screens: every screen of every app in
 * use, and who holding the app cannot open it. Job templates: named shapes of
 * access across every app, stamped onto people.
 *
 * Every change here goes through the same save as the Access dialog, person
 * by person, and the result names who moved and who was skipped and why.
 * ------------------------------------------------------------------------- */

type Overview = {
  powers: PowerOverview[];
  screens: ScreenOverview[];
  people: { userId: string; name: string; apps: string[] }[];
};

/** Shipped in the last three weeks — new enough that nobody may have decided it for anyone. */
function isRecent(since: string | null, today: string): boolean {
  if (!since) return false;
  const days =
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) /
    86_400_000;
  return days >= 0 && days <= 21;
}

function NewMark({ since }: { since: string }) {
  return (
    <span
      title={`Shipped ${dayLabel(since)}`}
      className="flex-none rounded-[3px] bg-brand-soft px-1 text-[10px] font-medium text-brand-hover"
    >
      new
    </span>
  );
}

export function PowersScreen({
  tab,
  overview,
  templates,
  today,
}: {
  tab: string;
  overview: Overview;
  templates: TemplateRow[];
  today: string;
}) {
  const [outcome, setOutcome] = React.useState<{
    title: string;
    result: BulkOutcome;
  } | null>(null);
  const router = useRouter();
  const done = (title: string, result: BulkOutcome) => {
    setOutcome({ title, result });
    router.refresh();
  };
  return (
    <div className="mt-5">
      {tab === "powers" ? (
        <PowersTab
          powers={overview.powers}
          people={overview.people}
          today={today}
          onDone={done}
        />
      ) : null}
      {tab === "screens" ? (
        <ScreensTab
          screens={overview.screens}
          people={overview.people}
          today={today}
          onDone={done}
        />
      ) : null}
      {tab === "templates" ? (
        <TemplatesTab
          templates={templates}
          people={overview.people}
          onDone={done}
        />
      ) : null}
      <OutcomeModal
        key={outcome?.title ?? "none"}
        outcome={outcome}
        onClose={() => setOutcome(null)}
      />
    </div>
  );
}

/* ================================================================ powers */

type Problem = "none" | "nobody" | "adminOnly" | "waiting";

function problemOf(p: PowerOverview): Problem {
  const byRow = p.holders.filter((h) => h.how === "row").length;
  if (!p.holders.length) return "nobody";
  if (!byRow && p.waiting && p.waiting.n > 0) return "adminOnly";
  if (!byRow) return "adminOnly";
  return "none";
}

function PowersTab({
  powers,
  people,
  today,
  onDone,
}: {
  powers: PowerOverview[];
  people: Overview["people"];
  today: string;
  onDone: (t: string, r: BulkOutcome) => void;
}) {
  const [app, setApp] = React.useState("all");
  const [q, setQ] = React.useState("");
  const [onlyProblems, setOnlyProblems] = React.useState(false);
  const [adding, setAdding] = React.useState<PowerOverview | null>(null);
  const [removing, setRemoving] = React.useState<PowerOverview | null>(null);

  const stuck = powers.filter(
    (p) =>
      p.waiting && p.waiting.n > 0 && !p.holders.some((h) => h.how === "row"),
  );
  const nobody = powers.filter((p) => !p.holders.some((h) => h.how === "row"));
  const needle = q.trim().toLowerCase();
  const shown = powers
    .filter((p) => app === "all" || p.app === app)
    .filter(
      (p) =>
        !needle ||
        `${p.label} ${p.source} ${p.key}`.toLowerCase().includes(needle),
    )
    .filter((p) => !onlyProblems || problemOf(p) !== "none")
    .sort((a, b) => {
      const w = (p: PowerOverview) =>
        p.waiting && p.waiting.n > 0 && !p.holders.some((h) => h.how === "row")
          ? 0
          : problemOf(p) !== "none"
            ? 1
            : 2;
      return w(a) - w(b);
    });

  return (
    <>
      {stuck.length ? (
        <Callout tone="danger">
          <div>
            <div className="font-medium text-ink">
              Work is waiting on{" "}
              {stuck.length === 1 ? "a power" : `${stuck.length} powers`} nobody
              holds
            </div>
            <div className="text-[13px] text-body">
              {stuck
                .map((p) => `${p.waiting!.n} ${p.waiting!.what} (${p.label})`)
                .join(" · ")}
              . Only an administrator can clear them today — give the power to
              the person whose job it is.
            </div>
          </div>
        </Callout>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterPills
          value={app}
          onChange={setApp}
          options={[
            { key: "all", label: "All" },
            { key: "erp", label: "ERP" },
            { key: "hrms", label: "HRMS" },
            { key: "tasks", label: "Tasks" },
          ]}
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search powers"
          className="w-64"
          aria-label="Search powers"
        />
        <Checkbox
          checked={onlyProblems}
          onChange={(e) => setOnlyProblems(e.target.checked)}
          label={`Only powers nobody holds by name (${nobody.length})`}
        />
      </div>
      {shown.length ? (
        <div className="grid gap-3">
          {shown.map((p) => (
            <PowerCard
              key={p.id}
              p={p}
              today={today}
              onAdd={() => setAdding(p)}
              onRemove={() => setRemoving(p)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState title="No power matches" />
        </Card>
      )}
      {adding ? (
        <PeoplePicker
          key={`add-${adding.id}`}
          title={`Give “${adding.label}”`}
          intro={
            adding.screens.length
              ? `They also get ${adding.screens.map((s) => s.label).join(", ")} where their ${adding.appName} is narrowed — the power is used there.`
              : `Held by row; an ${adding.appName} administrator already holds it.`
          }
          options={[
            ...adding.candidates.map((c) => ({
              id: c.userId,
              name: c.name,
              note: "",
            })),
            ...people
              .filter((x) => !x.apps.includes(adding.app))
              .map((x) => ({
                id: x.userId,
                name: x.name,
                note: `no ${adding.appName} yet`,
              })),
          ]}
          extraToggle={`Also give ${adding.appName} (as an associate) to anybody picked who does not hold it`}
          confirm="Give the power"
          onClose={() => setAdding(null)}
          onSubmit={(ids, extra) =>
            bulkPower({
              power: adding.id,
              on: true,
              userIds: ids,
              grantApp: extra,
            })
          }
          onDone={(r) => {
            setAdding(null);
            onDone(`Gave “${adding.label}”`, r);
          }}
        />
      ) : null}
      {removing ? (
        <PeoplePicker
          key={`rm-${removing.id}`}
          title={`Take away “${removing.label}”`}
          intro="Only grants by name can be taken away here. An administrator of the app holds every power of it — lower their level on their Access page instead."
          options={removing.holders
            .filter((h) => h.how === "row")
            .map((h) => ({ id: h.userId, name: h.name, note: "" }))}
          confirm="Take it away"
          danger
          onClose={() => setRemoving(null)}
          onSubmit={(ids) =>
            bulkPower({ power: removing.id, on: false, userIds: ids })
          }
          onDone={(r) => {
            setRemoving(null);
            onDone(`Took away “${removing.label}”`, r);
          }}
        />
      ) : null}
    </>
  );
}

function PowerCard({
  p,
  today,
  onAdd,
  onRemove,
}: {
  p: PowerOverview;
  today: string;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const byRow = p.holders.filter((h) => h.how === "row");
  const admins = p.holders.filter((h) => h.how === "admin");
  const waitingStuck = p.waiting && p.waiting.n > 0 && !byRow.length;
  return (
    <Card
      className={cx(
        "px-5 py-4",
        waitingStuck
          ? "border-l-[3px] border-l-danger"
          : !byRow.length
            ? "border-l-[3px] border-l-warn"
            : null,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{p.label}</span>
            <Badge tone="neutral">{p.appName}</Badge>
            {p.since && isRecent(p.since, today) ? (
              <NewMark since={p.since} />
            ) : null}
            {p.waiting ? (
              <Badge
                tone={
                  p.waiting.n > 0
                    ? byRow.length
                      ? "warn"
                      : "danger"
                    : "neutral"
                }
              >
                {p.waiting.n} {p.waiting.what}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 max-w-[860px] text-[13px] text-body">{p.source}</p>
          {p.screens.length ? (
            <div className="mt-1 text-[12px] text-muted">
              Used on: {p.screens.map((s) => s.label).join(", ")}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
            {byRow.length ? (
              byRow.map((h) => (
                <Link
                  key={h.userId}
                  href={ADMIN.person(h.userId, "apps")}
                  className="rounded-full border border-line bg-canvas px-2 py-0.5 text-body no-underline hover:border-line-strong"
                >
                  {h.name}
                </Link>
              ))
            ) : (
              <span
                className={
                  waitingStuck ? "font-medium text-danger" : "text-warn"
                }
              >
                Nobody holds it by name.
              </span>
            )}
            {admins.length ? (
              <span className="text-muted">
                · and {admins.map((a) => a.name).join(", ")} as {p.appName}{" "}
                administrator{admins.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-none gap-2">
          <Button size="sm" variant="primary" onClick={onAdd}>
            Give to…
          </Button>
          <Button
            size="sm"
            onClick={onRemove}
            disabled={!byRow.length}
            title={byRow.length ? undefined : "Nobody holds it by name"}
          >
            Take away…
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ================================================================ screens */

function ScreensTab({
  screens,
  people,
  today,
  onDone,
}: {
  screens: ScreenOverview[];
  people: Overview["people"];
  today: string;
  onDone: (t: string, r: BulkOutcome) => void;
}) {
  const apps = [
    ...new Map(screens.map((s) => [s.app, s.appName])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const [app, setApp] = React.useState<string>(
    apps.find(([a]) => a === "erp")?.[0] ?? apps[0]?.[0] ?? "",
  );
  const [q, setQ] = React.useState("");
  const [onlyMissing, setOnlyMissing] = React.useState(false);
  const [giving, setGiving] = React.useState<ScreenOverview | null>(null);
  const [taking, setTaking] = React.useState<ScreenOverview | null>(null);
  const needle = q.trim().toLowerCase();
  const shown = screens
    .filter((s) => s.app === app)
    .filter(
      (s) => !needle || `${s.label} ${s.group}`.toLowerCase().includes(needle),
    )
    .filter((s) => !onlyMissing || s.missing.length > 0);
  const newMissing = screens.filter(
    (s) => s.since && isRecent(s.since, today) && s.missing.length,
  );

  return (
    <>
      {newMissing.length ? (
        <Callout tone="warn">
          <div className="text-[13px] text-body">
            <span className="font-medium text-ink">
              New screens some people cannot open:{" "}
            </span>
            {newMissing
              .map((s) => `${s.appName} ${s.label} (${s.missing.length})`)
              .join(" · ")}
            . A narrowed grant does not receive new screens by itself.
          </div>
        </Callout>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          value={app}
          onChange={(e) => setApp(e.target.value)}
          aria-label="App"
          className="w-56"
        >
          {apps.map(([a, n]) => (
            <option key={a} value={a}>
              {n}
            </option>
          ))}
        </Select>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search screens"
          className="w-64"
          aria-label="Search screens"
        />
        <Checkbox
          checked={onlyMissing}
          onChange={(e) => setOnlyMissing(e.target.checked)}
          label="Only screens somebody with the app cannot open"
        />
      </div>
      <Card>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-divider text-left text-muted">
              <th className="px-5 py-2.5 font-medium">Screen</th>
              <th className="px-3 py-2.5 font-medium">Can open</th>
              <th className="px-3 py-2.5 font-medium">
                Holds the app but cannot open it
              </th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr
                key={s.key}
                className="border-b border-divider align-top last:border-0"
              >
                <td className="px-5 py-2.5">
                  <div className="flex items-center gap-1.5 font-medium text-ink">
                    {s.label}
                    {s.since && isRecent(s.since, today) ? (
                      <NewMark since={s.since} />
                    ) : null}
                  </div>
                  <div className="text-[12px] text-muted">{s.group}</div>
                </td>
                <td className="px-3 py-2.5 text-body">
                  {s.holders.length ? (
                    s.holders.map((h) => h.name).join(", ")
                  ) : (
                    <span className="text-warn">Nobody</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-body">
                  {s.missing.length ? (
                    s.missing.map((h) => h.name).join(", ")
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-5 py-2.5 text-right whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setGiving(s)}
                  >
                    Give to…
                  </Button>{" "}
                  <Button
                    size="sm"
                    onClick={() => setTaking(s)}
                    disabled={!s.holders.length}
                    title={s.holders.length ? undefined : "Nobody can open it"}
                  >
                    Take away…
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length ? <EmptyState title="No screen matches" /> : null}
      </Card>
      {giving ? (
        <PeoplePicker
          key={`give-${giving.key}`}
          title={`Give the ${giving.appName} screen “${giving.label}”`}
          intro="People who hold the whole app already open it. Ticking it for a narrowed grant adds just this screen."
          options={[
            ...giving.missing.map((m) => ({
              id: m.userId,
              name: m.name,
              note: "",
            })),
            ...people
              .filter((x) => !x.apps.includes(giving.app))
              .map((x) => ({
                id: x.userId,
                name: x.name,
                note: `no ${giving.appName} yet`,
              })),
          ]}
          extraToggle={`Also give ${giving.appName} (as an associate, this screen only) to anybody picked who does not hold it`}
          confirm="Give the screen"
          onClose={() => setGiving(null)}
          onSubmit={(ids, extra) =>
            bulkScreen({
              module: giving.key,
              on: true,
              userIds: ids,
              grantApp: extra,
            })
          }
          onDone={(r) => {
            setGiving(null);
            onDone(`Gave ${giving.label}`, r);
          }}
        />
      ) : null}
      {taking ? (
        <PeoplePicker
          key={`take-${taking.key}`}
          title={`Take away “${taking.label}”`}
          intro="Somebody who holds the whole app becomes narrowed to every other screen, and stops receiving new screens by themselves."
          options={taking.holders.map((h) => ({
            id: h.userId,
            name: h.name,
            note: h.whole ? "whole app" : "",
          }))}
          confirm="Take it away"
          danger
          onClose={() => setTaking(null)}
          onSubmit={(ids) =>
            bulkScreen({ module: taking.key, on: false, userIds: ids })
          }
          onDone={(r) => {
            setTaking(null);
            onDone(`Took away ${taking.label}`, r);
          }}
        />
      ) : null}
    </>
  );
}

/* ================================================================ templates */

const levelWord = (l: string) =>
  l === "admin" ? "admin" : l === "manager" ? "manager" : "associate";

function shapeSummary(t: TemplateRow): string[] {
  const out = t.shape.apps.map(
    (a) =>
      `${getApp(a.app)?.name ?? a.app} — ${levelWord(a.role)}, ${a.modules == null ? "every screen" : `${a.modules.length} screen${a.modules.length === 1 ? "" : "s"}`}`,
  );
  const powers = [
    ...t.shape.erpPowers.map((k) => powerById(`erp.${k}`)?.label ?? k),
    ...t.shape.hrmsPowers.map((k) => powerById(`hrms.${k}`)?.label ?? k),
    ...t.shape.taskPowers.map((k) => powerById(`tasks.${k}`)?.label ?? k),
  ];
  if (powers.length) out.push(`Powers: ${powers.join(", ")}`);
  return out;
}

function TemplatesTab({
  templates,
  people,
  onDone,
}: {
  templates: TemplateRow[];
  people: Overview["people"];
  onDone: (t: string, r: BulkOutcome) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<TemplateRow | null>(null);
  const [applying, setApplying] = React.useState<TemplateRow | null>(null);
  const [deleting, setDeleting] = React.useState<TemplateRow | null>(null);

  return (
    <>
      <Callout tone="info">
        <div className="text-[13px] text-body">
          A job template is a named shape of access across every app — the apps,
          the level each is held at, the screens and the powers. Applying one
          only ever <b>adds</b>: it never takes anything away, and editing a
          template later moves nobody. Make one from somebody who already has
          the right access.
        </div>
      </Callout>
      <div className="mb-4">
        <Button variant="primary" onClick={() => setCreating(true)}>
          New template from a person
        </Button>
      </div>
      {templates.length ? (
        <div className="grid gap-3">
          {templates.map((t) => (
            <Card key={t.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-ink">{t.name}</div>
                  {t.description ? (
                    <p className="mt-0.5 text-[13px] text-body">
                      {t.description}
                    </p>
                  ) : null}
                  <ul className="mt-1.5 list-disc pl-5 text-[13px] text-body">
                    {shapeSummary(t).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-none gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setApplying(t)}
                  >
                    Apply to…
                  </Button>
                  <Button size="sm" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setDeleting(t)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            title="No job templates yet"
            body="Make one from somebody whose access is right for their job — then stamp it onto the next person who does that job."
          />
        </Card>
      )}
      <NewTemplateModal key={creating ? "open" : "shut"} open={creating} people={people} onClose={() => setCreating(false)} />
      {editing ? <EditTemplateModal key={editing.id} t={editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        key={deleting?.id ?? "none"}
        open={deleting !== null}
        title={deleting ? `Delete the template “${deleting.name}”?` : ""}
        body="Nobody's access changes — applying a template stamps it, it does not stay linked. You just can't stamp this one onto anybody new."
        confirmLabel="Delete template"
        cancelLabel="Keep it"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const r = await toast.run(deleteAccessTemplate(deleting.id));
          if (r.ok) router.refresh();
        }}
        onClose={() => setDeleting(null)}
      />
      {applying ? (
        <PeoplePicker
          key={`apply-${applying.id}`}
          title={`Apply “${applying.name}”`}
          intro="Each person picked gains whatever in the template they do not hold yet — apps, screens, a higher level, powers. Nothing they hold is taken away."
          options={people.map((p) => ({
            id: p.userId,
            name: p.name,
            note: "",
          }))}
          confirm="Apply"
          onClose={() => setApplying(null)}
          onSubmit={(ids) =>
            applyAccessTemplate({ templateId: applying.id, userIds: ids })
          }
          onDone={(r) => {
            setApplying(null);
            onDone(`Applied “${applying.name}”`, r);
          }}
        />
      ) : null}
    </>
  );
}

function NewTemplateModal({
  open,
  people,
  onClose,
}: {
  open: boolean;
  people: Overview["people"];
  onClose: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const [from, setFrom] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New job template"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !from || !name.trim()}
            onClick={async () => {
              setBusy(true);
              const r = await toast.run(
                templateFromPerson({ userId: from, name, description }),
              );
              setBusy(false);
              if (r.ok) {
                router.refresh();
                onClose();
              }
            }}
          >
            Make template
          </Button>
        </>
      }
    >
      <Field label="Copy the access of">
        <Select value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Pick a person</option>
          {people.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Back office"
        />
      </Field>
      <Field label="What the job is (optional)">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </Field>
    </Modal>
  );
}

function EditTemplateModal({
  t,
  onClose,
}: {
  t: TemplateRow;
  onClose: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = React.useState(t.name);
  const [description, setDescription] = React.useState(t.description ?? "");
  const [apps, setApps] = React.useState(t.shape.apps);
  const [erp, setErp] = React.useState(t.shape.erpPowers);
  const [hrms, setHrms] = React.useState(t.shape.hrmsPowers);
  const [tasks, setTasks] = React.useState(t.shape.taskPowers);
  const [busy, setBusy] = React.useState(false);
  const toggle = (list: string[], set: (v: string[]) => void, k: string) =>
    set(list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  return (
    <Modal
      open
      width={640}
      onClose={onClose}
      title={`Edit “${t.name}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim() || !apps.length}
            onClick={async () => {
              setBusy(true);
              const r = await toast.run(
                saveAccessTemplate({
                  id: t.id,
                  name,
                  description,
                  shape: {
                    apps,
                    erpPowers: erp,
                    hrmsPowers: hrms,
                    taskPowers: tasks,
                  },
                }),
              );
              setBusy(false);
              if (r.ok) {
                router.refresh();
                onClose();
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="What the job is">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </Field>
      <div className="mb-2 text-[13px] font-medium text-ink">Apps</div>
      <div className="mb-3 grid gap-1.5">
        {apps.map((a, i) => (
          <div
            key={a.app}
            className="flex flex-wrap items-center gap-2 text-[13px]"
          >
            <span className="w-32 font-medium text-ink">
              {getApp(a.app)?.name ?? a.app}
            </span>
            <Select
              value={a.role}
              onChange={(e) =>
                setApps(
                  apps.map((x, j) =>
                    j === i
                      ? { ...x, role: e.target.value as typeof x.role }
                      : x,
                  ),
                )
              }
              className="w-36"
              aria-label="Level"
            >
              <option value="associate">Associate</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </Select>
            <span className="text-muted">
              {a.modules == null
                ? "every screen"
                : a.modules.map((m) => getModule(m)?.label ?? m).join(", ")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setApps(apps.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      {[
        ["ERP powers", erp, setErp, "erp"],
        ["HRMS powers", hrms, setHrms, "hrms"],
        ["Tasks permissions", tasks, setTasks, "tasks"],
      ].map(([label, list, set, app]) =>
        (list as string[]).length ? (
          <div key={app as string} className="mb-3">
            <div className="mb-1 text-[13px] font-medium text-ink">
              {label as string}
            </div>
            {(list as string[]).map((k) => (
              <Checkbox
                key={k}
                checked
                onChange={() =>
                  toggle(list as string[], set as (v: string[]) => void, k)
                }
                label={powerById(`${app}.${k}`)?.label ?? k}
              />
            ))}
          </div>
        ) : null,
      )}
      <p className="text-[12px] text-muted">
        To add apps, screens or powers, change the person&apos;s access and make
        a fresh template from them.
      </p>
    </Modal>
  );
}

/* ================================================================ shared */

function PeoplePicker({
  title,
  intro,
  options,
  extraToggle,
  confirm,
  danger,
  onClose,
  onSubmit,
  onDone,
}: {
  title: string;
  intro: string;
  options: { id: string; name: string; note: string }[];
  extraToggle?: string;
  confirm: string;
  danger?: boolean;
  onClose: () => void;
  onSubmit: (ids: string[], extra: boolean) => Promise<Result<BulkOutcome>>;
  onDone: (r: BulkOutcome) => void;
}) {
  const toast = useToast();
  const [picked, setPicked] = React.useState<string[]>([]);
  const [extra, setExtra] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  /* A take-away is reviewed before it is sent: the names, then the button.
     Picking twenty boxes in a long list is how the wrong person loses a power. */
  const [reviewing, setReviewing] = React.useState(false);
  const needle = q.trim().toLowerCase();
  const shown = options.filter(
    (o) => !needle || o.name.toLowerCase().includes(needle),
  );
  const needsApp = options.filter(
    (o) => o.note.startsWith("no ") && picked.includes(o.id),
  ).length;
  return (
    <Modal
      open
      width={560}
      onClose={onClose}
      title={title}
      footer={
        <>
          {reviewing ? (
            <Button onClick={() => setReviewing(false)}>Back</Button>
          ) : (
            <Button onClick={onClose}>Cancel</Button>
          )}
          {danger && !reviewing ? (
            <Button
              variant="primary"
              disabled={!picked.length}
              onClick={() => setReviewing(true)}
            >
              {`Review${picked.length ? ` (${picked.length})` : ""}`}
            </Button>
          ) : (
            <Button
              variant={danger ? "danger" : "primary"}
              disabled={busy || !picked.length || (needsApp > 0 && !extra)}
              title={
                needsApp > 0 && !extra
                  ? "Tick the box above to give the app to people who do not hold it"
                  : undefined
              }
              onClick={async () => {
                setBusy(true);
                const r = await onSubmit(picked, extra);
                setBusy(false);
                if (!r.ok) toast.push(r.error, "error");
                else onDone(r.data);
              }}
            >
              {busy
                ? "Saving…"
                : `${confirm}${picked.length ? ` (${picked.length})` : ""}`}
            </Button>
          )}
        </>
      }
    >
      {reviewing ? (
        <>
          <p className="mb-2 text-[13px] text-body">
            {picked.length === 1
              ? "This person loses it"
              : `These ${picked.length} people lose it`}{" "}
            from their next screen. Nothing else they hold changes, and it can
            be given back.
          </p>
          <ul className="max-h-[360px] list-disc overflow-y-auto pl-5 text-[13px] text-ink">
            {options
              .filter((o) => picked.includes(o.id))
              .map((o) => (
                <li key={o.id}>
                  {o.name}
                  {o.note ? (
                    <span className="ml-1.5 text-[12px] text-muted">
                      ({o.note})
                    </span>
                  ) : null}
                </li>
              ))}
          </ul>
        </>
      ) : (
        <>
          <p className="mb-3 text-[13px] text-body">{intro}</p>
          {options.length > 8 ? (
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search people"
              className="mb-2"
              aria-label="Search people"
            />
          ) : null}
          <div className="max-h-[360px] overflow-y-auto rounded-control border border-line px-3 py-2">
            {shown.length ? (
              shown.map((o) => (
                <Checkbox
                  key={o.id}
                  checked={picked.includes(o.id)}
                  onChange={() =>
                    setPicked(
                      picked.includes(o.id)
                        ? picked.filter((x) => x !== o.id)
                        : [...picked, o.id],
                    )
                  }
                  label={
                    <span>
                      {o.name}
                      {o.note ? (
                        <span className="ml-1.5 text-[12px] text-muted">
                          ({o.note})
                        </span>
                      ) : null}
                    </span>
                  }
                />
              ))
            ) : (
              <div className="py-3 text-center text-[13px] text-muted">
                Nobody to pick.
              </div>
            )}
          </div>
          {extraToggle && needsApp > 0 ? (
            <div className="mt-3">
              <Checkbox
                checked={extra}
                onChange={(e) => setExtra(e.target.checked)}
                label={extraToggle}
              />
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}

function OutcomeModal({
  outcome,
  onClose,
}: {
  outcome: { title: string; result: BulkOutcome } | null;
  onClose: () => void;
}) {
  if (!outcome) return null;
  const { moved, skipped } = outcome.result;
  return (
    <Modal
      open
      width={560}
      onClose={onClose}
      title={outcome.title}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {moved.length ? (
        <>
          <div className="mb-1 text-[13px] font-medium text-ink">
            Changed for {moved.length}
          </div>
          <ul className="mb-3 list-disc pl-5 text-[13px] text-body">
            {moved.map((m) => (
              <li key={m.userId}>
                <Link href={ADMIN.person(m.userId, "apps")}>{m.name}</Link> —{" "}
                {m.words}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mb-3 text-[13px] text-body">Nobody changed.</p>
      )}
      {skipped.length ? (
        <>
          <div className="mb-1 text-[13px] font-medium text-ink">
            Skipped {skipped.length}
          </div>
          <ul className="list-disc pl-5 text-[13px] text-muted">
            {skipped.map((s) => (
              <li key={s.userId}>
                {s.name} — {s.why}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}
