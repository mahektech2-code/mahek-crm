"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Td, Th, Tr } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { assignWorkAction, revokeAssignmentAction, setEnforceAssignmentsAction } from "@/lib/actions/website-cms";
import { KINDS, KIND_KEYS } from "@/lib/website-cms/kinds";
import type { AssignScreenData } from "@/lib/website-cms/review-queries";
import type { ScopeKind } from "@/lib/website-cms/review-scope";
import { reportResult } from "./report";
import { dateTime } from "./review-ui";

/* ---------------------------------------------------------------------------
 * ASSIGNING WEBSITE WORK — who may change what, and whether that is enforced.
 *
 * An assignment is a kind ("all Products"), one item ("this page"), or the media
 * library. It cannot open a screen: the person must already hold the Website
 * module it belongs to, and the picker says which kinds each person can be given.
 *
 * The enforcement switch is the one control here that changes what people can
 * do TODAY, so turning it on says in words what will happen, and how many people
 * it would shut out of editing until they are assigned something.
 * ------------------------------------------------------------------------- */

const ASSIGNABLE: { kind: ScopeKind; label: string }[] = [
  ...KIND_KEYS.map((k) => ({ kind: k as ScopeKind, label: KINDS[k].plural.replace(/^./, (c) => c.toUpperCase()) })),
  { kind: "media", label: "Media library" },
];

export function AssignScreen({ data }: { data: AssignScreenData }) {
  const router = useRouter();
  const toast = useToast();
  const [employeeId, setEmployeeId] = React.useState("");
  const [kind, setKind] = React.useState<ScopeKind | "">("");
  const [contentId, setContentId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [switching, setSwitching] = React.useState(false);

  const employee = data.employees.find((e) => e.id === employeeId);
  const itemsOfKind = kind && kind !== "media" ? data.items.filter((i) => i.kind === kind) : [];

  /** Whoever is assigned nothing, among those who hold a content module and no direct-edit right, would be locked out. */
  const unassigned = data.employees.filter((e) => e.kinds.length > 0 && !e.direct && !data.assignments.some((a) => a.employeeId === e.id)).length;

  async function assign() {
    if (!employeeId || !kind) return;
    setBusy(true);
    try {
      const r = await assignWorkAction(employeeId, kind, contentId || null, note.trim() || undefined);
      if (reportResult(toast, r)) {
        setContentId("");
        setNote("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      if (reportResult(toast, await revokeAssignmentAction(id))) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function setEnforced(on: boolean) {
    setBusy(true);
    try {
      if (reportResult(toast, await setEnforceAssignmentsAction(on))) router.refresh();
    } finally {
      setBusy(false);
      setSwitching(false);
    }
  }

  return (
    <div className="p-6">
      <PageHeader title="Assignments" subtitle="Decide who may change which part of the website. An employee can edit only what is assigned to them, and cannot publish." />

      <Card className="mb-4">
        <CardHeader
          title="Enforcement"
          hint={
            data.enforced
              ? "On: an editor changes only what they were assigned. Holders of “Publish to the live site” and “Review website changes” still edit directly."
              : "Off: anybody holding a Website module can edit what it covers, as before. Assignments below are recorded but do not restrict anyone yet."
          }
          action={
            <div className="flex items-center gap-3">
              <Badge tone={data.enforced ? "success" : "muted"}>{data.enforced ? "Enforced" : "Not enforced"}</Badge>
              <Button variant={data.enforced ? "secondary" : "primary"} disabled={busy} onClick={() => setSwitching(true)}>
                {data.enforced ? "Stop enforcing" : "Start enforcing"}
              </Button>
            </div>
          }
        />
      </Card>

      <Card className="mb-4">
        <CardHeader title="Assign work" hint="Pick a person, then what they may edit." />
        <div className="grid grid-cols-1 gap-4 px-5 py-4 md:grid-cols-2">
          <Field label="Employee">
            <Select
              value={employeeId}
              onChange={(e) => {
                setEmployeeId(e.target.value);
                setKind("");
                setContentId("");
              }}
            >
              <option value="">Choose a person…</option>
              {data.employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="What" hint={employee && employee.kinds.length === 0 ? `${employee.name} holds no Website content module. Give them one on the Access screen first.` : undefined}>
            <Select
              value={kind}
              disabled={!employee}
              onChange={(e) => {
                setKind(e.target.value as ScopeKind | "");
                setContentId("");
              }}
            >
              <option value="">Choose what to assign…</option>
              {ASSIGNABLE.map((a) => (
                <option key={a.kind} value={a.kind} disabled={!employee?.kinds.includes(a.kind)}>
                  {a.label}{employee && !employee.kinds.includes(a.kind) ? " — no module" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="How much"
            hint={kind === "media" ? "The media library is assigned as a whole." : "A whole kind also lets them add new items and reorder the list."}
          >
            <Select value={contentId} disabled={!kind || kind === "media"} onChange={(e) => setContentId(e.target.value)}>
              <option value="">{kind ? (kind === "media" ? "The whole library" : `Every ${KINDS[kind as keyof typeof KINDS].noun}`) : "—"}</option>
              {itemsOfKind.map((i) => (
                <option key={i.id} value={i.id}>{i.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Note (optional)" hint="Shown to them beside the assignment.">
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end border-t border-divider px-5 py-3">
          <Button variant="primary" disabled={busy || !employeeId || !kind} onClick={() => void assign()}>Assign</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Current assignments" hint={`${data.assignments.length} active`} />
        {data.assignments.length === 0 ? (
          <EmptyState title="Nothing is assigned yet" body="Assign work above. Until you turn enforcement on, assignments are a record and restrict nobody." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Assigned</Th>
                  <Th>Note</Th>
                  <Th>By</Th>
                  <Th align="right">&nbsp;</Th>
                </tr>
              </thead>
              <tbody>
                {data.assignments.map((a) => (
                  <Tr key={a.id}>
                    <Td className="font-medium text-ink">{a.employeeName}</Td>
                    <Td className="whitespace-normal">
                      <span className="text-ink">{a.itemLabel ?? `Every item in ${a.kindLabel}`}</span>{" "}
                      <Badge tone="neutral">{a.itemLabel ? a.kindLabel : "Whole kind"}</Badge>
                    </Td>
                    <Td className="max-w-[240px] whitespace-normal text-body">{a.scopeNote ?? ""}</Td>
                    <Td className="whitespace-normal text-muted">{a.assignedByName}<br /><span className="text-xs">{dateTime(a.assignedAt)}</span></Td>
                    <Td align="right"><Button size="sm" variant="secondary" disabled={busy} onClick={() => setRevoking(a.id)}>Take away</Button></Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={revoking !== null}
        title="Take this assignment away"
        body="They will no longer be able to edit it if assignments are enforced. A request they already submitted stays for you to decide."
        destructive
        confirmLabel="Take away"
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          const id = revoking;
          setRevoking(null);
          if (id) await revoke(id);
        }}
      />
      <ConfirmDialog
        open={switching}
        title={data.enforced ? "Stop enforcing assignments" : "Start enforcing assignments"}
        body={
          data.enforced
            ? "Anybody holding a Website module will again be able to edit everything that module covers."
            : unassigned > 0
              ? `From now on an editor can change only what was assigned to them. ${unassigned} ${unassigned === 1 ? "person who can edit has" : "people who can edit have"} no assignment and will be unable to edit anything until you give them some. People who hold Publish or Review are not affected.`
              : "From now on an editor can change only what was assigned to them. People who hold Publish or Review are not affected."
        }
        confirmLabel={data.enforced ? "Stop enforcing" : "Start enforcing"}
        destructive={!data.enforced}
        onClose={() => setSwitching(false)}
        onConfirm={() => setEnforced(!data.enforced)}
      />
      {data.enforced && data.assignments.length === 0 ? <Callout tone="warn">Assignments are enforced and nothing is assigned, so nobody without Publish or Review can edit.</Callout> : null}
    </div>
  );
}
