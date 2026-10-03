"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Card, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import type { Config } from "@/lib/config/registry";
import type { Collection } from "@/lib/config/entity-collections";
import { toStored, type SchemaTab } from "@/lib/config/schema-contract";
import { updateConfigSettings } from "@/lib/actions/crm";
import {
  changeSet,
  dirtyFields,
  impactRows,
  introducedProblems,
  readable,
  savedValue,
  type Values,
} from "./settings-model";
import { SettingsSection } from "./settings-section";
import { SettingsToolbar } from "./settings-tools";

/* ---------------------------------------------------------------------------
 * One tab of one app's settings, with everything that makes editing them safe:
 * per-field drafts, a consistency check over the whole configuration, a review
 * of the change set before it is applied, one-step undo, and a warning before
 * unsaved work is walked away from.
 *
 * It is the same editor for every settings page. It used to live inside the
 * console's one giant component and only the CRM's tabs could save — HRMS's
 * Save button said "not stored yet" and threw the change away, although the
 * server accepts any setting in the registry. Every page saves now, through
 * the same action and the same checks.
 * ------------------------------------------------------------------------- */

export function SettingsEditor({
  owner,
  tab,
  values: initial,
  config,
  warnings,
  canWrite,
  isPlatformAdmin,
  collections,
}: {
  /** The page's name, printed in the review and the export file's name. */
  owner: string;
  tab: SchemaTab;
  /** Stored values in console shape, keyed by setting. */
  values: Values;
  /** The whole stored configuration, for the consistency check the server also runs. */
  config: Config;
  /** Problems already present before anybody edits anything. */
  warnings: string[];
  canWrite: boolean;
  isPlatformAdmin: boolean;
  collections: Record<string, Collection>;
}) {
  const router = useRouter();
  const notify = useToast().push;

  // Saved values and, until Save, per-field drafts. Nothing is written until the
  // whole tab is saved — half the relationships only hold across fields.
  const [values, setValues] = React.useState<Values>(initial);
  const [drafts, setDrafts] = React.useState<Values>({});
  const [saving, setSaving] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  // What the last applied change set replaced, so it can be put back. Reset to
  // default is a different question from reset to what it was before I broke it.
  const [lastSet, setLastSet] = React.useState<null | {
    count: number;
    before: Values;
    entries: Array<{ key: string; value: unknown }>;
  }>(null);
  const [leaving, setLeaving] = React.useState<string | null>(null);

  const dirty = dirtyFields(tab, values, drafts);
  const errors = introducedProblems(tab, values, drafts, config);
  const impact = impactRows(tab, values, drafts);
  const readOnly = !canWrite;

  /*
   * LEAVING WITH UNSAVED WORK ASKS FIRST.
   *
   * The tabs and the sidebar are links now, not buttons this component owns, so
   * the guard listens for the click instead: any link inside the console while
   * there are drafts is held, and the person chooses. Closing the tab gets the
   * browser's own prompt.
   */
  React.useEffect(() => {
    if (!dirty.length) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement).closest("a");
      const href = a?.getAttribute("href");
      if (!a || !href || a.target === "_blank" || href.startsWith("#")) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaving(href);
    };
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [dirty.length]);

  async function commit() {
    const entries = changeSet(tab, values, drafts);
    setSaving(true);
    const result = await updateConfigSettings(entries);
    setSaving(false);
    if (!result.ok) {
      notify(result.error ?? "That did not save.");
      return;
    }
    setLastSet({
      count: dirty.length,
      before: Object.fromEntries(dirty.map((f) => [f.key, savedValue(values, f)])),
      entries: dirty.map((f) => ({ key: f.key, value: toStored(savedValue(values, f), f.control, f.def) })),
    });
    setValues((v) => ({ ...v, ...Object.fromEntries(dirty.map((f) => [f.key, drafts[f.key]])) }));
    setDrafts({});
    setReviewOpen(false);
    notify(result.message ?? "Saved");
    router.refresh();
  }

  function save() {
    if (errors.length) return notify("Fix the flagged relationships first");
    if (!dirty.length) return;
    // A change set is reviewed as one thing. A single change with no downstream
    // effect does not need a modal in front of it.
    if (impact.length || dirty.length > 1) return setReviewOpen(true);
    void commit();
  }

  async function rollback() {
    if (!lastSet) return;
    const result = await updateConfigSettings(lastSet.entries);
    if (!result.ok) return notify(result.error ?? "That did not roll back.");
    setValues((v) => ({ ...v, ...lastSet.before }));
    notify(
      lastSet.count === 1
        ? "Change set rolled back. The setting is back to what it was."
        : `Change set rolled back. ${lastSet.count} settings are back to what they were.`,
    );
    setLastSet(null);
    router.refresh();
  }

  return (
    <>
      <SettingsToolbar
        tab={tab}
        owner={owner}
        values={values}
        onImport={(incoming) => setDrafts((d) => ({ ...d, ...incoming }))}
      />

      {warnings.length ? (
        <div className="mt-4 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
          <div className="text-sm font-medium text-warn-ink">The stored configuration is already inconsistent</div>
          <div className="mt-1.5 flex flex-col gap-1">
            {warnings.map((w) => (
              <div key={w} className="text-sm leading-[21px] text-ink">
                {w}
              </div>
            ))}
          </div>
          <div className="mt-2 text-[13px] text-muted">
            Saving is not blocked by this — you cannot fix one half of it otherwise.
          </div>
        </div>
      ) : null}

      <SettingsSection
        tab={tab}
        values={values}
        drafts={drafts}
        errors={errors}
        onDraft={(key, value) => setDrafts((d) => ({ ...d, [key]: value }))}
        isPlatformAdmin={isPlatformAdmin}
        collections={collections}
      />

      <div className="sticky bottom-0 mt-5 bg-canvas pt-4">
        <Card className="flex items-center gap-3 px-5 py-3 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          <span className="text-sm text-body">
            {readOnly
              ? "Read-only. Configuration is changed by a manager."
              : errors.length
                ? `${errors.length} ${errors.length === 1 ? "relationship" : "relationships"} to fix before saving`
                : dirty.length
                  ? `${dirty.length} unsaved ${dirty.length === 1 ? "change" : "changes"} on this tab`
                  : "No unsaved changes. Values take effect the moment they are saved."}
          </span>
          <span className="flex-1" />
          {!dirty.length && lastSet ? (
            <Button variant="ghost" onClick={rollback}>
              Undo the last change set
            </Button>
          ) : null}
          {dirty.length ? (
            <Button variant="secondary" onClick={() => setDrafts({})}>
              Discard changes
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={readOnly || saving || !!errors.length || !dirty.length}
            title={
              readOnly
                ? "You can see these settings but not change them"
                : errors.length
                  ? "Fix the relationships above first"
                  : !dirty.length
                    ? "Nothing to save"
                    : undefined
            }
            onClick={save}
          >
            Save changes
          </Button>
        </Card>
      </div>

      <Modal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        title="Review this change set"
        width={620}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReviewOpen(false)}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={() => void commit()}>
              {saving ? "Saving…" : `Apply ${dirty.length} change${dirty.length === 1 ? "" : "s"}`}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-[21px] text-body">
          {impact.length
            ? "Applied together, as one change. Some of these alter who appears in a worklist tomorrow."
            : "Applied together, as one change, so the system is never briefly half-configured."}
        </div>
        <div className="mt-3.5 overflow-hidden rounded-[4px] border border-line">
          {dirty.map((f, i) => {
            const row = impact.find((r) => r.setting === f.label);
            return (
              <div key={f.key} className={cx("px-3.5 py-3", i ? "border-t border-canvas" : "")}>
                <div className="text-sm font-medium text-ink">{f.label}</div>
                <div className="mt-0.5 font-mono text-[13px] text-muted">
                  {readable(savedValue(values, f))} → <span className="text-ink">{readable(drafts[f.key])}</span>
                </div>
                {row?.effect ? (
                  <div
                    className={cx(
                      "mt-1.5 text-sm font-medium",
                      row.tone === "warn" ? "text-warn-ink" : row.tone === "ok" ? "text-success" : "text-body",
                    )}
                  >
                    {row.effect}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[13px] text-muted">Applying this can be undone in one action from the save bar.</div>
      </Modal>

      <Modal
        open={!!leaving}
        onClose={() => setLeaving(null)}
        title="Discard unsaved changes?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLeaving(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const href = leaving!;
                setDrafts({});
                setLeaving(null);
                router.push(href);
              }}
            >
              Discard
            </Button>
          </>
        }
      >
        <div className="text-sm leading-[21px] text-body">
          You have {dirty.length} unsaved {dirty.length === 1 ? "change" : "changes"} on this tab. Leaving discards them.
        </div>
      </Modal>
    </>
  );
}
