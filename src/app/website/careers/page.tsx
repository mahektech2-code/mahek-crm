"use client";

import * as React from "react";
import Link from "next/link";
import {
  Button,
  Callout,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Td,
  Th,
  Tr,
  EmptyState,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, RowMenu, ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "../status-badge";
import { JOBS, type Job, type Status } from "../mock-data";

export default function CareersPage() {
  const toast = useToast();
  const [jobs, setJobs] = React.useState<Job[]>(JOBS);
  const [editing, setEditing] = React.useState<Job | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [removing, setRemoving] = React.useState<Job | null>(null);

  function save(job: Job, isNew: boolean) {
    setJobs((all) => (isNew ? [job, ...all] : all.map((j) => (j.id === job.id ? job : j))));
    toast.push(isNew ? "Job posted." : "Job saved.");
    setCreating(false);
    setEditing(null);
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Careers"
        subtitle="Job postings shown on the public site."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Add Job</Button>}
      />

      <Callout tone="brand">
        Applications are managed in{" "}
        <Link href="/enquiries" className="font-medium underline">
          Enquiries
        </Link>
        , not here — this screen only decides which roles the public site shows.
      </Callout>

      <Card className="overflow-x-auto">
        {jobs.length === 0 ? (
          <EmptyState title="No roles posted" />
        ) : (
          <table className="w-full border-collapse" style={{ "--rowh": "52px" } as React.CSSProperties}>
            <thead>
              <tr>
                <Th>Title</Th>
                <Th>Department</Th>
                <Th>Location</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <Tr key={j.id}>
                  <Td>{j.title}</Td>
                  <Td>{j.department}</Td>
                  <Td>{j.location}</Td>
                  <Td><StatusBadge status={j.status} /></Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => setEditing(j) },
                        { label: "Delete", destructive: true, onSelect: () => setRemoving(j) },
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {creating ? (
        <JobEditor isNew job={null} onClose={() => setCreating(false)} onSave={(j) => save(j, true)} />
      ) : null}
      {editing ? (
        <JobEditor isNew={false} job={editing} onClose={() => setEditing(null)} onSave={(j) => save(j, false)} />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Delete job posting"
        body={`Delete "${removing?.title}"? This cannot be undone.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setJobs((all) => all.filter((j) => j.id !== removing?.id));
          toast.push("Job posting deleted.");
        }}
      />
    </div>
  );
}

function JobEditor({
  isNew,
  job,
  onClose,
  onSave,
}: {
  isNew: boolean;
  job: Job | null;
  onClose: () => void;
  onSave: (job: Job) => void;
}) {
  const [form, setForm] = React.useState<Job>(() =>
    job ?? {
      id: `j${Date.now()}`,
      title: "",
      department: "Manufacturing",
      location: "",
      status: "draft",
      updatedAt: new Date().toISOString().slice(0, 10),
    },
  );

  const fields = (
    <div className="flex flex-col gap-3.5">
      <Field label="Title">
        <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <Field label="Department">
        <Select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
          <option>Manufacturing</option>
          <option>Quality</option>
          <option>Sales</option>
          <option>Administration</option>
        </Select>
      </Field>
      <Field label="Location">
        <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
      </Field>
      <Field label="Status">
        <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
      </Field>
    </div>
  );

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => onSave({ ...form, updatedAt: new Date().toISOString().slice(0, 10) })}>
        {isNew ? "Add job" : "Save"}
      </Button>
    </>
  );

  if (isNew) {
    return (
      <Modal open onClose={onClose} title="Add Job" footer={footer} width={560}>
        {fields}
      </Modal>
    );
  }

  return (
    <Drawer open onClose={onClose} width={480} label="Edit job">
      <DrawerHeader onClose={onClose}>Edit Job</DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">{fields}</div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
    </Drawer>
  );
}
