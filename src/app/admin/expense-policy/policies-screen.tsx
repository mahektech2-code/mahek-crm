"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { ConfirmDialog, Modal, RowMenu, SelectionBar, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  assignPolicySet,
  setExpenseHometown,
  createPolicySet,
  deletePolicySet,
  duplicatePolicySet,
  setPolicySetActive,
} from "@/lib/actions/expense-policy-sets";
import { ADMIN } from "@/lib/admin-routes";
import { AdminPage } from "../_shell/admin-page";

/* ---------------------------------------------------------------------------
 * EXPENSE POLICIES — the standard one and every other, and who is on which.
 *
 * Two questions, two tabs. "What policies are there" is the table of
 * policies, each opening its editor. "Which policy is this salesman on" is the
 * people tab: a dropdown on every row that saves the moment it changes, and a
 * selection bar to move a whole team at once.
 * ------------------------------------------------------------------------- */

export type PolicySummary = {
  id: string;
  name: string;
  description: string | null;
  isStandard: boolean;
  active: boolean;
  ruleCount: number;
  memberCount: number;
  revision: number;
  updatedAt: string | null;
  updatedByName: string | null;
  clonedFromName: string | null;
};

export type PersonRow = {
  userId: string;
  name: string;
  email: string | null;
  position: string | null;
  active: boolean;
  setId: string | null;
  setName: string | null;
  setInactive: boolean;
  assignedAt: string | null;
  assignedByName: string | null;
  hometown: string | null;
};

const STANDARD = "__standard";

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PoliciesScreen({
  sets,
  people,
  towns,
  canWrite,
  initialTab,
}: {
  sets: PolicySummary[];
  people: PersonRow[];
  /** Towns offered when a hometown is typed. */
  towns: string[];
  canWrite: boolean;
  initialTab: "policies" | "people";
}) {
  const router = useRouter();
  const { run } = useToast();
  const [tab, setTab] = React.useState<"policies" | "people">(initialTab);
  const [creating, setCreating] = React.useState<{ fromId: string } | null>(null);
  const [duplicating, setDuplicating] = React.useState<PolicySummary | null>(null);
  const [deleting, setDeleting] = React.useState<PolicySummary | null>(null);

  const standard = sets.find((s) => s.isStandard);
  const onOther = people.filter((p) => p.setId && !p.setInactive).length;
  const onStandard =
    people.filter((p) => p.active).length - people.filter((p) => p.active && p.setId && !p.setInactive).length;

  const refuse = canWrite ? undefined : "Only accounts and administrators may change expense policies.";

  return (
    <AdminPage
      title="Expense policies"
      subtitle="What the field is paid back for travel, meals, hotels and bills. Everybody is on the standard policy unless they are put on another one."
      actions={
        <Button
          variant="primary"
          disabled={!canWrite}
          title={refuse}
          onClick={() => setCreating({ fromId: standard?.id ?? "" })}
        >
          New policy
        </Button>
      }
    >
      <Tabs
        className="mt-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "policies", label: "Policies", count: sets.length },
          { key: "people", label: "Who is on which", count: people.length },
        ]}
      />

      {tab === "policies" ? (
        <Card className="mt-4 overflow-hidden">
          <CardHeader
            title="Policies"
            hint={`${onStandard} on the standard policy · ${onOther} on another. A switched-off policy's people are paid on the standard one until it is switched back on.`}
          />
          {sets.length === 0 ? (
            <EmptyState
              title="No policies yet"
              body="The standard policy appears here the first time the page loads."
            />
          ) : (
            <div className="overflow-auto">
              <table className="w-full min-w-[980px] table-fixed">
                <thead>
                  <tr>
                    <Th style={{ width: 340 }}>Policy</Th>
                    <Th style={{ width: 110 }}>Status</Th>
                    <Th style={{ width: 170 }}>Who is on it</Th>
                    <Th style={{ width: 80 }} align="right">
                      Rules
                    </Th>
                    <Th style={{ width: 200 }}>Last saved</Th>
                    <Th style={{ width: 80 }} />
                  </tr>
                </thead>
                <tbody>
                  {sets.map((s) => (
                    <Tr key={s.id}>
                      <Td className="py-2.5 whitespace-normal">
                        <Link href={ADMIN.expensePolicy(s.id)} className="font-medium text-ink hover:underline">
                          {s.name}
                        </Link>
                        {s.isStandard ? (
                          <Badge tone="brand" className="ml-2">
                            Standard
                          </Badge>
                        ) : null}
                        {s.description ? <div className="mt-0.5 text-[12px] text-muted">{s.description}</div> : null}
                        {s.clonedFromName ? (
                          <div className="mt-0.5 text-[12px] text-muted">Copied from {s.clonedFromName}</div>
                        ) : null}
                      </Td>
                      <Td>
                        {s.active ? <Badge tone="success">Active</Badge> : <Badge tone="muted">Switched off</Badge>}
                      </Td>
                      <Td>
                        {s.isStandard ? (
                          <span>Everybody else · {onStandard}</span>
                        ) : (
                          <span>
                            {s.memberCount} {s.memberCount === 1 ? "person" : "people"}
                          </span>
                        )}
                      </Td>
                      <Td align="right">{s.ruleCount}</Td>
                      <Td className="whitespace-normal text-[13px]">
                        {when(s.updatedAt)}
                        {s.updatedByName ? (
                          <div className="text-[12px] text-muted">
                            by {s.updatedByName} · rev {s.revision}
                          </div>
                        ) : null}
                      </Td>
                      <Td align="right">
                        <RowMenu
                          items={[
                            {
                              label: canWrite ? "Edit" : "Open",
                              onSelect: () => router.push(ADMIN.expensePolicy(s.id)),
                            },
                            {
                              label: "Duplicate",
                              onSelect: () => setDuplicating(s),
                              disabled: !canWrite,
                              title: refuse,
                            },
                            {
                              label: "New policy from this one",
                              onSelect: () => setCreating({ fromId: s.id }),
                              disabled: !canWrite,
                              title: refuse,
                            },
                            ...(s.isStandard
                              ? []
                              : [
                                  {
                                    label: s.active ? "Switch off" : "Switch on",
                                    disabled: !canWrite,
                                    title: refuse,
                                    onSelect: () =>
                                      void run(setPolicySetActive({ id: s.id, active: !s.active })).then((r) => {
                                        if (r.ok) router.refresh();
                                      }),
                                  },
                                  {
                                    label: "Delete",
                                    destructive: true,
                                    disabled: !canWrite,
                                    title: refuse,
                                    onSelect: () => setDeleting(s),
                                  },
                                ]),
                          ]}
                        />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <PeopleTab sets={sets} people={people} towns={towns} canWrite={canWrite} />
      )}

      {creating ? (
        <CreateDialog
          key={creating.fromId}
          sets={sets}
          fromId={creating.fromId}
          onClose={() => setCreating(null)}
          onCreated={(id) => router.push(ADMIN.expensePolicy(id))}
        />
      ) : null}

      {duplicating ? (
        <DuplicateDialog
          key={duplicating.id}
          source={duplicating}
          onClose={() => setDuplicating(null)}
          onCreated={(id) => router.push(ADMIN.expensePolicy(id))}
        />
      ) : null}

      <ConfirmDialog
        open={!!deleting}
        title={`Delete "${deleting?.name ?? ""}"?`}
        body={
          deleting?.memberCount
            ? `${deleting.memberCount} ${deleting.memberCount === 1 ? "person goes" : "people go"} back to the standard policy. A policy that has already priced a day cannot be deleted — switch it off instead.`
            : "It is on nobody. A policy that has already priced a day cannot be deleted — switch it off instead."
        }
        confirmLabel="Delete"
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const r = await run(deletePolicySet({ id: deleting.id }));
          if (r.ok) router.refresh();
        }}
      />
    </AdminPage>
  );
}

/* ------------------------------------------------------------ dialogs */

function CreateDialog({
  sets,
  fromId,
  onClose,
  onCreated,
}: {
  sets: PolicySummary[];
  fromId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { run } = useToast();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [from, setFrom] = React.useState(fromId || "blank");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await run(createPolicySet({ name, description: description || null, fromId: from }));
      if (r.ok) onCreated(r.data.id);
      else setError(r.fieldErrors?.find((f) => f.field === "name")?.message ?? r.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New expense policy"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || name.trim().length < 2} onClick={submit}>
            Create and edit
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="Name" error={error}>
          <Input
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Outstation salesmen"
          />
        </Field>
        <Field label="What it is for" hint="Optional. Shown under the name on the list.">
          <Textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Start from" hint="Its rules are copied in, and you change what differs.">
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                A copy of {s.name}
                {s.isStandard ? " (standard)" : ""}
              </option>
            ))}
            <option value="blank">Nothing — an empty policy</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function DuplicateDialog({
  source,
  onClose,
  onCreated,
}: {
  source: PolicySummary;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { run } = useToast();
  const [name, setName] = React.useState(`Copy of ${source.name}`.slice(0, 80));
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Duplicate "${source.name}"`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await run(duplicatePolicySet({ id: source.id, name }));
                if (r.ok) onCreated(r.data.id);
              } finally {
                setBusy(false);
              }
            }}
          >
            Duplicate
          </Button>
        </>
      }
    >
      <Field
        label="Name of the copy"
        hint={`All ${source.ruleCount} rules are copied. Nobody is moved onto it until you assign them.`}
      >
        <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------- people */

function PeopleTab({
  sets,
  people,
  towns,
  canWrite,
}: {
  sets: PolicySummary[];
  people: PersonRow[];
  towns: string[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<string>("all");
  const [showInactive, setShowInactive] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = React.useState<string>(STANDARD);
  const [busyIds, setBusyIds] = React.useState<Set<string>>(new Set());

  const assignable = sets.filter((s) => s.active && !s.isStandard);
  const standard = sets.find((s) => s.isStandard);
  const effective = (p: PersonRow) => (p.setId && !p.setInactive ? p.setId : STANDARD);

  const rows = people.filter((p) => {
    if (!showInactive && !p.active) return false;
    if (filter !== "all" && effective(p) !== filter) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [p.name, p.email ?? "", p.position ?? "", p.setName ?? ""].some((v) => v.toLowerCase().includes(needle));
  });

  async function move(userIds: string[], target: string) {
    setBusyIds((b) => new Set([...b, ...userIds]));
    try {
      const r = await run(assignPolicySet({ userIds, setId: target === STANDARD ? null : target }));
      if (r.ok) {
        setPicked(new Set());
        router.refresh();
      }
    } finally {
      setBusyIds((b) => {
        const n = new Set(b);
        for (const u of userIds) n.delete(u);
        return n;
      });
    }
  }

  const allShown = rows.length > 0 && rows.every((r) => picked.has(r.userId));

  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader
        title="Who is on which policy"
        hint="Everybody who holds the Salesman App. Change a row's policy and it is saved at once, re-works today's allowances and tells him on his phone. A hometown decides which days count as away from home — with none set, every day he records as away is."
      />
      <div className="flex flex-wrap items-end gap-3 border-b border-divider px-5 py-3">
        <Field label="Search" className="w-[260px]">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, position…" />
        </Field>
        <Field label="Policy" className="w-[260px]">
          <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Every policy</option>
            <option value={STANDARD}>{standard?.name ?? "Standard"} (standard)</option>
            {sets
              .filter((s) => !s.isStandard)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.active ? "" : " (switched off)"}
                </option>
              ))}
          </Select>
        </Field>
        <label className="mb-1.5 flex items-center gap-2 text-[13px] text-body">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show disabled accounts
        </label>
        <span className="mb-2 ml-auto text-[13px] text-muted">
          {rows.length} of {people.length}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nobody here" body="Nobody matches that search, or nobody holds the Salesman App yet." />
      ) : (
        <div className="max-h-[640px] overflow-auto">
          <datalist id="expense-hometown-towns">
            {towns.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <table className="w-full min-w-[1140px] table-fixed">
            <thead>
              <tr>
                <Th style={{ width: 44 }}>
                  <input
                    type="checkbox"
                    aria-label="Pick everybody shown"
                    checked={allShown}
                    disabled={!canWrite}
                    onChange={() =>
                      setPicked((p) => {
                        const n = new Set(p);
                        if (allShown) rows.forEach((r) => n.delete(r.userId));
                        else rows.forEach((r) => n.add(r.userId));
                        return n;
                      })
                    }
                  />
                </Th>
                <Th style={{ width: 260 }}>Person</Th>
                <Th style={{ width: 200 }}>Position</Th>
                <Th style={{ width: 290 }}>Expense policy</Th>
                <Th style={{ width: 190 }}>Hometown</Th>
                <Th style={{ width: 190 }}>Since</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <Tr key={p.userId} className={cx(!p.active && "opacity-60")}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Pick ${p.name}`}
                      checked={picked.has(p.userId)}
                      disabled={!canWrite}
                      onChange={() =>
                        setPicked((s) => {
                          const n = new Set(s);
                          if (n.has(p.userId)) n.delete(p.userId);
                          else n.add(p.userId);
                          return n;
                        })
                      }
                    />
                  </Td>
                  <Td className="truncate" title={p.email ?? undefined}>
                    <span className="font-medium text-ink">{p.name}</span>
                    {!p.active ? <span className="ml-1.5 text-[12px] text-muted">disabled</span> : null}
                  </Td>
                  <Td className="truncate" title={p.position ?? undefined}>
                    {p.position ?? <span className="text-muted">—</span>}
                  </Td>
                  <Td>
                    <Select
                      className="w-full"
                      disabled={!canWrite || busyIds.has(p.userId)}
                      title={refuseTitle(canWrite)}
                      value={p.setId && !p.setInactive ? p.setId : STANDARD}
                      onChange={(e) => void move([p.userId], e.target.value)}
                    >
                      <option value={STANDARD}>{standard?.name ?? "Standard"} (standard)</option>
                      {assignable.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                    {p.setInactive ? (
                      <div className="mt-0.5 text-[12px] text-warn-ink">
                        Assigned {p.setName}, which is switched off — paid on standard.
                      </div>
                    ) : null}
                  </Td>
                  <Td>
                    <HometownCell key={p.hometown ?? ""} person={p} canWrite={canWrite} />
                  </Td>
                  <Td className="whitespace-normal text-[12px] text-muted">
                    {p.assignedAt ? (
                      <>
                        {when(p.assignedAt)}
                        {p.assignedByName ? <div>by {p.assignedByName}</div> : null}
                      </>
                    ) : (
                      "Standard since the start"
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SelectionBar count={picked.size} onClear={() => setPicked(new Set())}>
        <span className="text-[13px]">Move to</span>
        <select
          className="h-8 rounded-[4px] border border-body bg-ink px-2 text-[13px] text-white"
          value={bulkTarget}
          onChange={(e) => setBulkTarget(e.target.value)}
        >
          <option value={STANDARD}>{standard?.name ?? "Standard"} (standard)</option>
          {assignable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="primary" onClick={() => void move([...picked], bulkTarget)}>
          Move {picked.size}
        </Button>
      </SelectionBar>
    </Card>
  );
}

function refuseTitle(canWrite: boolean) {
  return canWrite ? undefined : "Only accounts and administrators may change who is on which policy.";
}

/* ----------------------------------------------------------- hometown */

/** Typed against the place tree's towns, saved when the box is left. */
function HometownCell({ person, canWrite }: { person: PersonRow; canWrite: boolean }) {
  const router = useRouter();
  const { run } = useToast();
  const [value, setValue] = React.useState(person.hometown ?? "");
  const [busy, setBusy] = React.useState(false);

  async function commit() {
    const next = value.trim();
    if (next === (person.hometown ?? "")) return;
    setBusy(true);
    try {
      const r = await run(setExpenseHometown({ userId: person.userId, city: next || null }));
      if (r.ok) router.refresh();
      else setValue(person.hometown ?? "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="block">
      <Input
        list="expense-hometown-towns"
        value={value}
        maxLength={80}
        placeholder="Not set"
        aria-label={`Hometown of ${person.name}`}
        disabled={!canWrite || busy}
        title={refuseTitle(canWrite)}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </span>
  );
}
