"use client";

import * as React from "react";
import { PageHeader, Button, Card, Field, Input, Select, Textarea, Th, Td, Tr, EmptyState, Callout } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, FilterPills, RowMenu } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import Link from "next/link";
import { INITIAL_JOBS, ADMIN_USERS, formatDate, type JobPosting } from "../mock-data";
import { StatusBadge } from "../status-badge";

const CURRENT_USER = ADMIN_USERS[0];
type Filter = "all" | JobPosting["status"];

export default function CareersPage() {
  const toast = useToast();
  const [jobs, setJobs] = React.useState<JobPosting[]>(INITIAL_JOBS);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [editing, setEditing] = React.useState<JobPosting | null>(null);

  const filtered = jobs.filter((j) => filter === "all" || j.status === filter);

  function upsert(j: JobPosting) {
    setJobs((prev) => (prev.some((x) => x.id === j.id) ? prev.map((x) => (x.id === j.id ? j : x)) : [...prev, j]));
  }
  function setStatus(j: JobPosting, status: JobPosting["status"]) {
    upsert({ ...j, status, updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER });
  }
  function openNew() {
    setEditing({ id: `job_${Date.now()}`, title: "", department: "", location: "Ambernath MIDC", type: "Full-time", description: "", status: "draft", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER });
  }

  return (
    <>
      <PageHeader title="Careers" subtitle="Job postings only — applications are managed in Enquiries." actions={<Button variant="primary" onClick={openNew}><Icon name="plus" size={16} /> Add Job</Button>} />

      <Callout tone="brand">
        Applications submitted through the public Career form are not managed here. They arrive as Career enquiries — see the{" "}
        <Link href="/enquiries" className="font-medium text-brand hover:text-brand-hover">Enquiries app</Link>.
      </Callout>

      <div className="mb-3">
        <FilterPills
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "All", count: jobs.length },
            { key: "open", label: "Open", count: jobs.filter((j) => j.status === "open").length },
            { key: "draft", label: "Draft", count: jobs.filter((j) => j.status === "draft").length },
            { key: "closed", label: "Closed", count: jobs.filter((j) => j.status === "closed").length },
          ]}
        />
      </div>

      <Card className="overflow-x-auto">
        {filtered.length === 0 ? (
          <EmptyState title="No job postings" action={<Button variant="primary" onClick={openNew}>Add Job</Button>} />
        ) : (
          <table className="w-full">
            <thead><Tr><Th>Title</Th><Th>Department</Th><Th>Location</Th><Th>Type</Th><Th>Status</Th><Th>Updated</Th><Th align="right">Actions</Th></Tr></thead>
            <tbody>
              {filtered.map((j) => (
                <Tr key={j.id}>
                  <Td className="font-medium text-ink"><button onClick={() => setEditing(j)} className="cursor-pointer hover:text-brand">{j.title}</button></Td>
                  <Td>{j.department}</Td>
                  <Td>{j.location}</Td>
                  <Td>{j.type}</Td>
                  <Td><StatusBadge status={j.status} /></Td>
                  <Td>{formatDate(j.updatedAt)}</Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => setEditing(j) },
                        { label: "Preview", onSelect: () => toast.push("Preview: /career (prototype only)") },
                        ...(j.status !== "open" ? [{ label: "Publish", onSelect: () => { setStatus(j, "open"); toast.push("Published — now open"); } }] : []),
                        ...(j.status === "open" ? [{ label: "Close position", onSelect: () => { setStatus(j, "closed"); toast.push("Closed"); }, destructive: true }] : []),
                        ...(j.status === "closed" ? [{ label: "Reopen", onSelect: () => { setStatus(j, "open"); toast.push("Reopened"); } }] : []),
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing ? (
        <Drawer open onClose={() => setEditing(null)} label="Job editor">
          <DrawerHeader onClose={() => setEditing(null)}>
            <div className="text-lg font-semibold text-ink">{editing.title || "New job posting"}</div>
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="grid gap-4">
              <Field label="Job title"><Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Department"><Input value={editing.department} onChange={(e) => setEditing({ ...editing, department: e.target.value })} /></Field>
                <Field label="Location"><Input value={editing.location} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></Field>
              </div>
              <Field label="Employment type">
                <Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                  <option>Full-time</option><option>Part-time</option><option>Contract</option>
                </Select>
              </Field>
              <Field label="Description"><Textarea rows={6} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
              <Field label="Status">
                <Select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as JobPosting["status"] })}>
                  <option value="draft">Draft</option><option value="open">Open</option><option value="closed">Closed</option>
                </Select>
              </Field>
            </div>
          </div>
          <div className="flex flex-none items-center justify-end gap-2.5 border-t border-line px-5 py-3.5">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="secondary" onClick={() => { upsert({ ...editing, status: editing.status === "open" ? "open" : "draft" }); toast.push("Draft saved"); setEditing(null); }}>Save Draft</Button>
            <Button variant="primary" onClick={() => { upsert({ ...editing, status: "open" }); toast.push("Published — now open"); setEditing(null); }}>Publish</Button>
          </div>
        </Drawer>
      ) : null}
    </>
  );
}
