"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { shortDate } from "@/lib/format";
import {
  publishCourse,
  setCoursePublished,
  uploadPublishFile,
} from "@/lib/actions/sales";
import type { CourseRow } from "@/lib/services/sales-service";
import {
  Banner,
  Button,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";
import { plural } from "../words";

/**
 * Training a salesman is expected to have done, and the door that publishes it.
 *
 * The column that matters is how many of the team have finished it, against how
 * many there are — a mandatory course two people out of eleven have completed is
 * the fact this screen exists to surface, and a list of course titles is not.
 *
 * **A course may have no file, unlike a document.** A briefing somebody
 * delivers in a meeting is still a course to record and to tick off; a document
 * with nothing behind it is a row that lists and will not open. Two different
 * things, two different rules.
 *
 * **A deadline needs a compulsory course.** A date on something optional is a
 * date with no consequence, drawn on the handset as though it had one — refused
 * in the action as well as disabled here.
 *
 * **Withdrawing keeps the progress.** Somebody finished it; taking the material
 * down does not unfinish it.
 */
export function KnowledgeScreen({ rows }: { rows: CourseRow[] }) {
  const router = useRouter();
  const toast = useToast();

  const [title, setTitle] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [minutes, setMinutes] = React.useState("");
  const [mandatory, setMandatory] = React.useState(false);
  const [dueDate, setDueDate] = React.useState("");
  const [file, setFile] = React.useState<{ id: string; filename: string } | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pickerKey, setPickerKey] = React.useState(0);

  async function choose(chosen: File | undefined) {
    if (!chosen) return;
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.set("file", chosen);
    let result;
    try {
      result = await uploadPublishFile(form);
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setUploading(false);
    }
    if (!result.ok) {
      setError(result.error);
      setPickerKey((k) => k + 1);
      return;
    }
    setFile(result.data);
    if (!title.trim()) setTitle(result.data.filename.replace(/\.[^.]+$/, ""));
  }

  async function publish() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await publishCourse({
        title,
        category: category || null,
        durationMinutes: minutes ? Number(minutes) : null,
        attachmentId: file?.id ?? null,
        mandatory,
        dueDate: mandatory && dueDate ? dueDate : null,
      });
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTitle("");
    setCategory("");
    setMinutes("");
    setMandatory(false);
    setDueDate("");
    setFile(null);
    setPickerKey((k) => k + 1);
    toast.push(result.message ?? "Published.");
    router.refresh();
  }

  async function toggle(row: CourseRow) {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setCoursePublished({ courseId: row.id, published: !row.active });
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  const live = rows.filter((c) => c.active);
  const compulsory = live.filter((c) => c.mandatory);
  const behind = compulsory.filter((c) => c.completed < c.team);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Knowledge"
        subtitle="What the field team is expected to have learnt, and how much of it they have. A mandatory course nobody has finished is the thing worth seeing here."
      />

      {error ? <Banner tone="danger" title="That did not work" body={error} /> : null}

      <div className="mb-4 rounded-[6px] border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Course
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Handling a damage complaint"
              className="h-8.5 w-[300px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Kind
            </span>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Product, Selling, Safety"
              title="Typed rather than picked. There is no fixed list of course kinds, and a picker would need maintaining every time somebody invented one."
              className="h-8.5 w-[180px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Minutes
            </span>
            <input
              type="number"
              min={1}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder="20"
              className="h-8.5 w-[90px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Material
            </span>
            <input
              key={pickerKey}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={(e) => void choose(e.target.files?.[0])}
              className="h-8.5 w-[260px] rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px] text-body file:mr-2 file:rounded-[3px] file:border-0 file:bg-canvas file:px-2 file:py-1 file:text-[12px] file:text-body"
            />
          </label>
          <label className="flex h-8.5 items-center gap-2 text-sm text-body">
            <input
              type="checkbox"
              checked={mandatory}
              onChange={(e) => setMandatory(e.target.checked)}
              className="size-4 accent-[#5223E0]"
            />
            Compulsory
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              By
            </span>
            <input
              type="date"
              value={dueDate}
              disabled={!mandatory}
              onChange={(e) => setDueDate(e.target.value)}
              title={
                mandatory
                  ? "The day it has to be finished by."
                  : "A deadline only means something on a compulsory course."
              }
              className="h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <Button
            tone="primary"
            disabled={busy || uploading || !title.trim()}
            title={
              uploading
                ? "Storing the material."
                : !title.trim()
                  ? "A course needs a title."
                  : undefined
            }
            onClick={() => void publish()}
          >
            {busy ? "Publishing…" : "Publish"}
          </Button>
        </div>

        <p className="mt-2 text-[13px] text-pretty text-muted">
          {uploading
            ? "Storing the material…"
            : file
              ? `${file.filename} is stored and will be attached when you publish.`
              : "Material is optional — a briefing somebody delivers in a meeting is still a course to record and tick off."}
        </p>
      </div>

      {rows.length === 0 ? (
        <Empty
          title="No training has been published"
          body="Publish one above and it reaches every handset on its next sync."
        />
      ) : (
        <>
          <MetricRow
            metrics={[
              { label: "Courses", value: String(live.length) },
              { label: "Compulsory", value: String(compulsory.length) },
              {
                label: "Not everybody has done",
                value: String(behind.length),
                tone: behind.length ? "warn" : undefined,
              },
            ]}
          />

          <Table
            minWidth={1120}
            head={
              <>
                <HeadCell width={320}>Course</HeadCell>
                <HeadCell width={140}>Kind</HeadCell>
                <HeadCell width={100}>Length</HeadCell>
                <HeadCell width={140}>By</HeadCell>
                <HeadCell width={180}>Done</HeadCell>
                <HeadCell width={130}>State</HeadCell>
                <HeadCell align="right" width={130} />
              </>
            }
          >
            {rows.map((c, i) => (
              <Row key={c.id} striped={i % 2 === 1}>
                <Cell truncate={320}>
                  <span className="font-medium text-ink">{c.title}</span>
                </Cell>
                <Cell className="capitalize">
                  {c.category ?? <span className="text-muted">—</span>}
                </Cell>
                <Cell>
                  {c.durationMinutes ? (
                    `${c.durationMinutes} min`
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell>
                  {c.dueDate ? shortDate(c.dueDate) : <span className="text-muted">No date</span>}
                </Cell>
                <Cell>
                  <span className="tabular-nums">
                    {c.completed} of {c.team}
                  </span>
                  {c.started > c.completed ? (
                    <span className="block text-[12px] text-muted">
                      {plural(c.started - c.completed, "more")} part way
                    </span>
                  ) : null}
                </Cell>
                <Cell>
                  {!c.active ? (
                    <Pill>Withdrawn</Pill>
                  ) : c.mandatory && c.completed < c.team ? (
                    <Pill tone="warn">Compulsory</Pill>
                  ) : c.mandatory ? (
                    <Pill tone="success">All done</Pill>
                  ) : (
                    <Pill>Optional</Pill>
                  )}
                </Cell>
                <Cell align="right">
                  <Button
                    size="sm"
                    tone={c.active ? "danger" : "default"}
                    disabled={busy}
                    title={
                      c.active
                        ? "Takes the material off every handset. Anybody part-way through keeps their record of it."
                        : "Puts it back on every handset."
                    }
                    onClick={() => void toggle(c)}
                  >
                    {c.active ? "Withdraw" : "Publish again"}
                  </Button>
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}
