"use client";

/* ---------------------------------------------------------------------------
 * EVERY PRICE LIST THAT ARRIVED AS A FILE, and how far it got.
 *
 * This is a worklist rather than a report: the point of the screen is the
 * column saying what each document is waiting for, and every row carries the
 * way to move it on. A document that failed says so where somebody can press
 * "Re-parse"; one that is ready says what there is to review before opening
 * it, so a reviewer can choose the one worth ten minutes.
 *
 * Confidence is a bar rather than a number, because 0.62 is a figure nobody
 * has a scale for and a bar next to four others is a comparison anybody can
 * read at a glance. What it is NOT is a verdict — a low bar on a document that
 * matched everything is a document worth opening, not one to throw away.
 *
 * Every destructive action is refused with its reason on the control rather
 * than hidden: a published document cannot be deleted, and the menu says that
 * instead of quietly not offering it.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Progress,
  Td,
  Th,
  Tr,
} from "@/components/ui/primitives";
import { ConfirmDialog, RowMenu, type MenuItem } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { DOCUMENT_STATUS_LABEL, DOCUMENT_STATUS_TONE } from "@/lib/price-list-labels";
import type { DocumentView } from "@/lib/price-list-views";
import { stamp } from "@/lib/format";
import { deleteDocument, reparseDocument } from "@/lib/actions/price-lists";
import { ImportModal } from "@/components/pricing/modals/import-modal";
import { RejectDocumentModal } from "@/components/pricing/modals/reject-document-modal";

type Dialog =
  | { kind: "reparse"; document: DocumentView }
  | { kind: "reject"; document: DocumentView }
  | { kind: "delete"; document: DocumentView };

export function DocumentsPanel({
  basePath,
  canManage,
  documents,
  openImport,
  todayIso,
}: {
  basePath: string;
  canManage: boolean;
  documents: DocumentView[];
  openImport: boolean;
  todayIso: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [importing, setImporting] = React.useState(openImport && canManage);
  const [importKey, setImportKey] = React.useState(0);
  const [dialog, setDialog] = React.useState<Dialog | null>(null);

  function openImportModal() {
    setImportKey((k) => k + 1);
    setImporting(true);
  }

  function menuFor(document: DocumentView): MenuItem[] {
    const published = document.parseStatus === "published";
    return [
      { label: "Review", onSelect: () => router.push(`${basePath}/documents/${document.id}`) },
      {
        label: "Re-parse",
        disabled: !canManage || published,
        title: !canManage
          ? "Only somebody who can manage price lists may read a file again."
          : published
            ? "This one already became a price list; re-reading it would change nothing."
            : undefined,
        onSelect: () => setDialog({ kind: "reparse", document }),
      },
      {
        label: "Reject",
        disabled: !canManage || published,
        title: !canManage
          ? "Only somebody who can manage price lists may reject a document."
          : published
            ? "This one became a price list. Withdraw the list instead."
            : undefined,
        onSelect: () => setDialog({ kind: "reject", document }),
      },
      {
        label: "Delete",
        destructive: true,
        disabled: !canManage || published,
        title: !canManage
          ? "Only somebody who can manage price lists may delete a document."
          : published
            ? "The price list points back at this file, so it stays."
            : undefined,
        onSelect: () => setDialog({ kind: "delete", document }),
      },
    ];
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Documents"
          hint="Every price list that came in as a file, and what is holding it up."
          action={
            <Button
              variant="primary"
              size="sm"
              disabled={!canManage}
              title={canManage ? undefined : "Importing a price list is not something you can do."}
              onClick={openImportModal}
            >
              Import price lists
            </Button>
          }
        />

        {documents.length === 0 ? (
          <EmptyState
            title="No documents waiting"
            body="A price list starts life as the PDF somebody was sent. Drop it in and it is read, matched to the catalogue and held for review before anything is published."
            action={
              canManage ? (
                <Button variant="primary" onClick={openImportModal}>
                  Import price lists
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-auto" style={{ ["--rowh" as string]: "52px" }}>
            <table className="w-full min-w-[1040px] border-collapse">
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>Uploaded</Th>
                  <Th align="right">Pages</Th>
                  <Th>Status</Th>
                  <Th>Confidence</Th>
                  <Th align="right">Matched</Th>
                  <Th align="right">To check</Th>
                  <Th align="right">Held</Th>
                  <Th>Became</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <Tr key={document.id} className="hover:bg-canvas">
                    <Td className="max-w-[260px] whitespace-normal">
                      <Link
                        href={`${basePath}/documents/${document.id}`}
                        className="font-medium text-ink hover:text-brand hover:underline"
                      >
                        {document.filename}
                      </Link>
                      <div className="text-[11px] text-muted">
                        {document.layout && document.layout !== "unknown"
                          ? `${document.layout === "grid" ? "A grid of pack sizes" : "One price a line"} · `
                          : null}
                        {document.rowCount} {document.rowCount === 1 ? "cell" : "cells"}
                      </div>
                    </Td>
                    <Td>
                      <div className="text-body">{document.uploadedByName ?? "Somebody"}</div>
                      <div className="text-[11px] text-muted">{stamp(document.createdAt)}</div>
                    </Td>
                    <Td align="right">{document.pageCount ?? "—"}</Td>
                    <Td className="max-w-[220px] whitespace-normal">
                      <Badge tone={DOCUMENT_STATUS_TONE[document.parseStatus]}>
                        {DOCUMENT_STATUS_LABEL[document.parseStatus]}
                      </Badge>
                      {document.stageNote ? (
                        <div className="mt-0.5 text-[11px] text-muted">{document.stageNote}</div>
                      ) : document.rejectReason ? (
                        <div className="mt-0.5 text-[11px] text-muted">{document.rejectReason}</div>
                      ) : null}
                    </Td>
                    <Td className="w-[120px]">
                      {document.confidence === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <>
                          <Progress
                            value={Math.round(document.confidence * 100)}
                            tone={
                              document.confidence >= 0.8
                                ? "success"
                                : document.confidence >= 0.55
                                  ? "warn"
                                  : "danger"
                            }
                            className="w-[92px]"
                          />
                          <div className="mt-1 text-[11px] text-muted">
                            {Math.round(document.confidence * 100)}% sure of the reading
                          </div>
                        </>
                      )}
                    </Td>
                    <Td align="right">{document.matchedCount}</Td>
                    <Td align="right" className={document.suggestedCount ? "text-warn-ink" : undefined}>
                      {document.suggestedCount}
                    </Td>
                    <Td align="right" className={document.heldCount ? "text-danger" : undefined}>
                      {document.heldCount}
                    </Td>
                    <Td>
                      {document.priceListId ? (
                        <Link
                          href={`${basePath}/${document.priceListId}`}
                          className="text-brand hover:underline"
                        >
                          {document.priceListName ?? "The price list"}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                    <Td align="right">
                      <RowMenu items={menuFor(document)} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ImportModal
        open={importing}
        openKey={importKey}
        basePath={basePath}
        todayIso={todayIso}
        onClose={() => setImporting(false)}
      />

      <RejectDocumentModal
        open={dialog?.kind === "reject"}
        documentId={dialog?.kind === "reject" ? dialog.document.id : ""}
        filename={dialog?.kind === "reject" ? dialog.document.filename : ""}
        onClose={() => setDialog(null)}
      />

      <ConfirmDialog
        open={dialog?.kind === "reparse"}
        title="Read this file again?"
        body="Everything somebody has already answered stands; the rest is read from scratch. This is the one to run when the reading rule changed rather than the file."
        confirmLabel="Re-parse"
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== "reparse") return;
          await run(reparseDocument(dialog.document.id));
          setDialog(null);
          router.refresh();
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === "delete"}
        title="Delete this document?"
        body="The file and everything read off it go. Rejecting it instead keeps the record and your reason."
        confirmLabel="Delete"
        destructive
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== "delete") return;
          await run(deleteDocument(dialog.document.id));
          setDialog(null);
          router.refresh();
        }}
      />
    </>
  );
}
