"use client";

/* ---------------------------------------------------------------------------
 * MAKING A PRICE LIST HERE, the whole way through, in one place.
 *
 * Start → Details → Rates → Terms → Applies to → Review → Preview. Each step
 * is a tab rather than a wizard page, because the office jumps: a price
 * changed on the review page, a clause fixed after the preview. The footer
 * is the same on every step — how far through it is, what is wrong, and the
 * two ways out: save it as a draft, or put it in force.
 *
 * WHAT IS BEING EDITED IS ONE `PriceSheet`, and every change is a new sheet
 * pushed onto a history, so Undo and Redo are exact and every button in the
 * rates grid is a pure function (`editor-state.ts`). The same sheet is what
 * the preview draws, what the review checks, what the read-back verifies and
 * what the server saves — nothing is re-derived between the screen and the
 * paper.
 *
 * A PUBLISHED LIST IS NEVER EDITED IN PLACE. Opening one here makes a new
 * version: the grid arrives filled, and saving it writes a new draft that
 * supersedes the old list only when it is published.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { WorkspaceModal, StepTabs } from "@/components/pricing/workspace-modal";
import type { PricingApp, PricingOptions, ScopeView } from "@/lib/price-list-views";
import type { PriceDerivation, PriceListStatus } from "@/db/schema";
import { checkSheet, copyName, printedDate, type PriceSheet, type SheetCheck } from "@/lib/price-sheet";
import { savePriceSheet } from "@/lib/actions/price-sheets";
import {
  addFamilies,
  blankSheet,
  deriveSheet,
  sheetFromProductCells,
  sheetStats,
  type EditorScope,
  type StartSource,
} from "@/components/pricing/editor/editor-state";
import { familiesOf } from "@/lib/price-sheet";
import { StartPanel, type StartChoice } from "@/components/pricing/editor/start-panel";
import { DetailsPanel } from "@/components/pricing/editor/details-panel";
import { RatesPanel } from "@/components/pricing/editor/rates-panel";
import { TermsPanel } from "@/components/pricing/editor/terms-panel";
import { ScopesPanel } from "@/components/pricing/editor/scopes-panel";
import { ReviewPanel, type EditorStep } from "@/components/pricing/editor/review-panel";
import { PreviewPanel } from "@/components/pricing/editor/preview-panel";

export type EditorOpen =
  | { kind: "new"; source: StartSource; fromListId?: string }
  | { kind: "edit"; listId: string };

type ListSheet = {
  sheet: PriceSheet;
  listId: string;
  status: PriceListStatus;
  version: number;
  notes: string | null;
  parentListId: string | null;
  derivation: PriceDerivation | null;
  scopes: ScopeView[];
  baseline: Record<string, number>;
};

const OUTLIER_BP = 2500;
const HISTORY_CAP = 80;

async function fetchListSheet(id: string): Promise<ListSheet | null> {
  try {
    const r = await fetch(`/api/price-lists/${id}/sheet`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as ListSheet;
  } catch {
    return null;
  }
}

function toEditorScopes(scopes: ScopeView[]): EditorScope[] {
  return scopes.map((s) => ({
    key: s.id,
    kind: s.scopeKind,
    value: s.scopeValue,
    label: s.scopeLabel ?? s.scopeValue,
    parentKey: s.parentKey,
    freightTermMatch: s.freightTermMatch,
  }));
}

export function PriceListEditor(props: {
  open: EditorOpen | null;
  onClose: () => void;
  app: PricingApp;
  basePath: string;
  options: PricingOptions;
  todayIso: string;
  defaultGstBp?: number;
}) {
  if (!props.open) return null;
  const key = props.open.kind === "edit" ? `edit:${props.open.listId}` : `new:${props.open.source}:${props.open.fromListId ?? ""}`;
  return <EditorBody key={key} {...props} open={props.open} />;
}

type History = { past: PriceSheet[]; present: PriceSheet; future: PriceSheet[]; labels: string[] };

function EditorBody({
  open,
  onClose,
  basePath,
  options,
  todayIso,
  defaultGstBp = 1800,
}: {
  open: EditorOpen;
  onClose: () => void;
  app: PricingApp;
  basePath: string;
  options: PricingOptions;
  todayIso: string;
  defaultGstBp?: number;
}) {
  const router = useRouter();
  const { run } = useToast();
  const products = options.products;

  const [history, setHistory] = React.useState<History>(() => ({
    past: [],
    present: blankSheet(todayIso, defaultGstBp),
    future: [],
    labels: [],
  }));
  const sheet = history.present;
  const [step, setStep] = React.useState<EditorStep>(open.kind === "new" && open.source !== "blank" && open.source !== "catalogue" && !open.fromListId ? "start" : "details");
  const [mode, setMode] = React.useState<"create" | "update" | "version">(open.kind === "edit" ? "update" : "create");
  const [listId, setListId] = React.useState<string | null>(open.kind === "edit" ? open.listId : null);
  const [supersedesId, setSupersedesId] = React.useState("");
  const [sourceName, setSourceName] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState("");
  const [scopes, setScopes] = React.useState<EditorScope[]>([]);
  const [parentListId, setParentListId] = React.useState<string | null>(null);
  const [derivation, setDerivation] = React.useState<PriceDerivation | null>(null);
  const [baseline, setBaseline] = React.useState<Record<string, number> | null>(null);
  const [baselineName, setBaselineName] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(open.kind === "edit" || !!(open.kind === "new" && open.fromListId));
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState<"draft" | "publish" | null>(null);
  const [confirmingClose, setConfirmingClose] = React.useState(false);
  const [confirmingPublish, setConfirmingPublish] = React.useState(false);
  const [lastChange, setLastChange] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<string | null>(null);

  const change = React.useCallback((next: PriceSheet, label: string) => {
    setHistory((h) => ({
      past: [...h.past, h.present].slice(-HISTORY_CAP),
      present: next,
      future: [],
      labels: [...h.labels, label].slice(-HISTORY_CAP),
    }));
    setDirty(true);
    setLastChange(label);
  }, []);

  const reset = React.useCallback((next: PriceSheet) => {
    setHistory({ past: [], present: next, future: [], labels: [] });
  }, []);

  const undo = React.useCallback(() => {
    setHistory((h) => {
      if (!h.past.length) return h;
      setLastChange(`Undid: ${h.labels[h.labels.length - 1] ?? "a change"}`);
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], labels: h.labels.slice(0, -1) };
    });
    setDirty(true);
  }, []);

  const redo = React.useCallback(() => {
    setHistory((h) => {
      if (!h.future.length) return h;
      setLastChange("Redid a change");
      return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), labels: [...h.labels, "Redo"] };
    });
    setDirty(true);
  }, []);

  /* Ctrl/⌘-Z anywhere but inside a text box, where the browser's own undo is the right one. */
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  /* ---- loading an existing list, or the list a start is taken from ----- */
  const loadSheet = React.useCallback(async (id: string) => (await fetchListSheet(id))?.sheet ?? null, []);

  const begin = React.useCallback(
    async (choice: StartChoice) => {
      const base = blankSheet(todayIso, defaultGstBp);
      if (choice.source === "blank") {
        reset(base);
      } else if (choice.source === "catalogue") {
        reset(addFamilies(base, familiesOf(products.filter((p) => p.active))));
      } else if (choice.source === "csv") {
        reset({ ...sheetFromProductCells(base, choice.cells, products), name: choice.filename.replace(/\.[a-z0-9]+$/i, "") });
      } else {
        setLoading(true);
        const found = await fetchListSheet(choice.listId);
        setLoading(false);
        if (!found) {
          setLoadError("That list could not be read.");
          return;
        }
        const taken = options.lists.map((l) => l.name);
        if (choice.source === "copy") {
          reset({ ...found.sheet, name: copyName(found.sheet.name, taken), effectiveFrom: todayIso });
          setScopes(toEditorScopes(found.scopes).map((s) => ({ ...s, key: `copy:${s.key}` })));
        } else {
          const derived = deriveSheet(found.sheet, choice.rule);
          reset({ ...derived, name: `${found.sheet.name} (derived)`, refNo: null, effectiveFrom: found.sheet.effectiveFrom > todayIso ? found.sheet.effectiveFrom : todayIso });
          setParentListId(found.listId);
          setDerivation(choice.rule);
        }
        setBaseline(found.baseline);
        setBaselineName(found.sheet.name);
      }
      setDirty(true);
      setStep("details");
    },
    [todayIso, defaultGstBp, products, options.lists, reset],
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (open.kind === "edit") {
        const found = await fetchListSheet(open.listId);
        if (cancelled) return;
        setLoading(false);
        if (!found) return setLoadError("That list could not be read.");
        const isDraft = found.status === "draft";
        reset(isDraft ? found.sheet : { ...found.sheet, effectiveFrom: found.sheet.effectiveFrom > todayIso ? found.sheet.effectiveFrom : todayIso });
        setMode(isDraft ? "update" : "version");
        setListId(found.listId);
        setSupersedesId(isDraft ? "" : found.listId);
        setSourceName(`${found.sheet.name} (v${found.version})`);
        setNotes(found.notes ?? "");
        setScopes(toEditorScopes(found.scopes));
        setParentListId(found.parentListId);
        setDerivation(found.derivation);
        setBaseline(found.baseline);
        setBaselineName(isDraft ? "the saved draft" : `version ${found.version}`);
      } else if (open.fromListId) {
        await begin(open.source === "derive" ? { source: "derive", listId: open.fromListId, rule: { kind: "per_litre_paise", paise: 1200 } } : { source: "copy", listId: open.fromListId });
        if (!cancelled) setLoading(false);
      } else if (open.source === "catalogue") {
        await begin({ source: "catalogue" });
      } else if (open.source === "blank") {
        await begin({ source: "blank" });
        setDirty(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once per open; `key` on the body remounts it for a different list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- checks ---------------------------------------------------------- */
  const checks: SheetCheck[] = React.useMemo(() => {
    const base = checkSheet(sheet, {
      todayIso,
      baseline: baseline ? new Map(Object.entries(baseline)) : null,
      outlierBp: OUTLIER_BP,
    });
    if (!scopes.length) base.push({ level: "warn", code: "scopes", message: "It names nobody, so once published it prices no shop. Say who it applies to." });
    return base;
  }, [sheet, todayIso, baseline, scopes.length]);

  const flags = React.useMemo(() => {
    const m = new Map<string, "warn" | "block">();
    for (const c of checks) for (const at of c.cells ?? []) if (c.level !== "info" && m.get(at) !== "block") m.set(at, c.level as "warn" | "block");
    return m;
  }, [checks]);

  const blocks = checks.filter((c) => c.level === "block").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  const stats = sheetStats(sheet);
  const errors: Record<string, string> = {};
  if (!sheet.name.trim()) errors.name = "A list needs a name people will recognise.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sheet.effectiveFrom)) errors.effectiveFrom = "That is not a date.";

  /* ---- saving ---------------------------------------------------------- */
  async function save(publish: boolean) {
    if (errors.name) {
      setStep("details");
      return;
    }
    setSaving(publish ? "publish" : "draft");
    try {
      const r = await run(
        savePriceSheet({
          mode,
          listId,
          sheet,
          notes,
          scopes: scopes.map((s) => ({ kind: s.kind, value: s.value, label: s.label, parentKey: s.parentKey, freightTermMatch: s.freightTermMatch })),
          parentListId,
          derivation,
          publish: publish ? { supersedesId: supersedesId || null } : null,
        }),
      );
      if (!r.ok) return;
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }));
      if (r.data.published) {
        onClose();
        router.push(`${basePath}/${r.data.listId}`);
        router.refresh();
        return;
      }
      // Saved as a draft: every later save updates that same draft.
      setListId(r.data.listId);
      setMode("update");
      router.refresh();
    } finally {
      setSaving(null);
      setConfirmingPublish(false);
    }
  }

  function requestClose() {
    if (dirty) setConfirmingClose(true);
    else onClose();
  }

  const title =
    mode === "version" ? `New version of ${sourceName ?? "the list"}` : mode === "update" ? sheet.name || "Draft price list" : sheet.name || "New price list";

  const steps: Array<{ key: EditorStep; label: string; tone?: "ok" | "warn" | "block" | null }> = [
    ...(open.kind === "new" && !listId ? [{ key: "start" as const, label: "Start" }] : []),
    { key: "details", label: "Details", tone: errors.name || errors.effectiveFrom ? "block" : null },
    { key: "rates", label: `Rates${stats.priced ? ` · ${stats.priced}` : ""}`, tone: checks.some((c) => c.level === "block" && ["zero", "empty"].includes(c.code)) ? "block" : stats.empty ? "warn" : stats.priced ? "ok" : null },
    { key: "terms", label: "Terms" },
    { key: "scopes", label: `Applies to${scopes.length ? ` · ${scopes.length}` : ""}`, tone: scopes.length ? "ok" : "warn" },
    { key: "review", label: "Review", tone: blocks ? "block" : warns ? "warn" : "ok" },
    { key: "preview", label: "Preview & export" },
  ];

  return (
    <WorkspaceModal
      title={title}
      badge={
        mode === "version" ? (
          <Badge tone="brand">new version</Badge>
        ) : mode === "update" ? (
          <Badge tone="neutral">draft</Badge>
        ) : (
          <Badge tone="brand">new</Badge>
        )
      }
      subtitle={
        loading
          ? "Reading the list…"
          : `${stats.rows} lines · ${stats.columns} packs · ${stats.priced} prices · effective ${printedDate(sheet.effectiveFrom)}${derivation ? " · derived by rule" : ""}`
      }
      actions={
        <div className="hidden items-center gap-1 sm:flex">
          <Button size="sm" variant="ghost" onClick={undo} disabled={!history.past.length} title={history.labels.length ? `Undo: ${history.labels[history.labels.length - 1]} (⌘Z)` : "Nothing to undo"}>
            ↶ Undo
          </Button>
          <Button size="sm" variant="ghost" onClick={redo} disabled={!history.future.length} title="Redo (⇧⌘Z)">
            ↷ Redo
          </Button>
        </div>
      }
      tabs={step === "start" && open.kind === "new" && !listId ? null : <StepTabs steps={steps} value={step} onChange={setStep} />}
      onRequestClose={requestClose}
      bodyClassName={step === "rates" || step === "preview" ? "p-0" : "px-5 py-5"}
      footer={
        <>
          <div className="min-w-0 text-[12.5px] text-muted">
            {saving ? (
              <span>{saving === "publish" ? "Putting it in force…" : "Saving…"}</span>
            ) : dirty ? (
              <span>
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-warn align-middle" />
                Unsaved{lastChange ? ` — ${lastChange}` : ""}
              </span>
            ) : savedAt ? (
              <span>Draft saved at {savedAt}</span>
            ) : (
              <span>{listId ? "No changes since it was opened" : "Nothing saved yet"}</span>
            )}
            {blocks ? <span className="ml-3 text-danger">{blocks} to fix before publishing</span> : warns ? <span className="ml-3 text-warn-ink">{warns} worth a look</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={requestClose}>
              Close
            </Button>
            {step !== "review" && step !== "start" ? (
              <Button variant="ghost" onClick={() => setStep("review")}>
                Review
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => void save(false)} disabled={!!saving || loading || step === "start"}>
              {mode === "update" && listId ? "Save draft" : "Save as draft"}
            </Button>
            <Button
              variant="primary"
              onClick={() => (blocks ? setStep("review") : setConfirmingPublish(true))}
              disabled={!!saving || loading || step === "start"}
              title={blocks ? "Open the review to see what has to be fixed first." : undefined}
            >
              {mode === "version" ? "Publish new version" : "Publish"}
            </Button>
          </div>
        </>
      }
    >
      {loadError ? <Callout tone="danger">{loadError}</Callout> : null}
      {loading ? (
        <div className="flex h-full items-center justify-center text-[13px] text-muted">Reading the list…</div>
      ) : step === "start" ? (
        <StartPanel
          initial={open.kind === "new" ? open.source : "blank"}
          lists={options.lists}
          products={products}
          taxBasis={sheet.taxBasis}
          gstBp={sheet.gstBp}
          busy={loading}
          onStart={(c) => void begin(c)}
        />
      ) : step === "details" ? (
        <DetailsPanel
          sheet={sheet}
          onChange={change}
          notes={notes}
          onNotes={(v) => {
            setNotes(v);
            setDirty(true);
          }}
          mode={mode === "update" && supersedesId ? "version" : mode}
          supersedesId={supersedesId}
          onSupersedes={(id) => {
            setSupersedesId(id);
            setDirty(true);
          }}
          lists={options.lists}
          sourceName={sourceName}
          errors={errors}
        />
      ) : step === "rates" ? (
        <RatesPanel sheet={sheet} onChange={change} products={products} lists={options.lists} baseline={baseline} flags={flags} loadSheet={loadSheet} />
      ) : step === "terms" ? (
        <TermsPanel sheet={sheet} onChange={change} />
      ) : step === "scopes" ? (
        <ScopesPanel
          scopes={scopes}
          onChange={(s) => {
            setScopes(s);
            setDirty(true);
          }}
          options={options}
          mode={mode}
        />
      ) : step === "review" ? (
        <ReviewPanel sheet={sheet} checks={checks} scopes={scopes} baseline={baseline} baselineName={baselineName} products={products} mode={mode} onGo={setStep} />
      ) : (
        <PreviewPanel sheet={sheet} products={products} />
      )}

      {confirmingClose ? (
        <Modal
          open
          onClose={() => setConfirmingClose(false)}
          title="Close without saving?"
          width={460}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmingClose(false)}>
                Keep editing
              </Button>
              <Button variant="danger" onClick={onClose}>
                Discard changes
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  setConfirmingClose(false);
                  await save(false);
                  onClose();
                }}
              >
                Save draft and close
              </Button>
            </>
          }
        >
          <p className="text-[14px] text-body">
            {history.past.length} change{history.past.length === 1 ? "" : "s"} on this list {listId ? "since it was last saved" : "have never been saved"}.
            A draft prices nothing, so saving it is always safe.
          </p>
        </Modal>
      ) : null}

      {confirmingPublish ? (
        <Modal
          open
          onClose={() => setConfirmingPublish(false)}
          title={mode === "version" ? "Put this version in force?" : "Put this list in force?"}
          width={540}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmingPublish(false)}>
                Not yet
              </Button>
              <Button variant="primary" onClick={() => void save(true)} disabled={!!saving}>
                {saving ? "Publishing…" : "Publish"}
              </Button>
            </>
          }
        >
          <ul className="list-disc space-y-1.5 pl-5 text-[14px] text-body">
            <li>
              <span className="font-medium text-ink">{sheet.name}</span> prices {stats.priced} SKU{stats.priced === 1 ? "" : "s"} from{" "}
              <span className="font-medium text-ink">{printedDate(sheet.effectiveFrom)}</span>.
            </li>
            {supersedesId ? (
              <li>
                It replaces <span className="font-medium text-ink">{options.lists.find((l) => l.id === supersedesId)?.name ?? sourceName}</span>, which is dated out the
                day before.
              </li>
            ) : null}
            <li className={cx(!scopes.length && "text-warn-ink")}>
              {scopes.length
                ? `It applies to ${scopes.map((s) => (s.kind === "everybody" ? "every shop" : s.label)).join(", ")}.`
                : supersedesId
                  ? "It names nobody itself, so it takes over whoever the list it replaces applied to."
                  : "It names nobody, so it will price no shop until somebody is added."}
            </li>
            {stats.empty ? <li className="text-warn-ink">{stats.empty} empty cell{stats.empty === 1 ? " is" : "s are"} left off.</li> : null}
            {warns ? <li className="text-warn-ink">{warns} thing{warns === 1 ? "" : "s"} on the review page are worth a look first.</li> : null}
            <li>Its PDF is drawn, read back through the importer, and kept as the list&apos;s document.</li>
          </ul>
        </Modal>
      ) : null}
    </WorkspaceModal>
  );
}
