"use client";

import * as React from "react";
import { Button, Input, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { VoiceTextarea } from "@/components/ui/dictate";
import { polishChatReply } from "@/lib/actions/crm";

/* ---------------------------------------------------------------------------
 * THE LOOK BEFORE A REPLY LEAVES.
 *
 * Send in a conversation opens this rather than sending. A typed answer goes
 * from the business number to a customer's phone and cannot be taken back, so
 * it is read once more, by the person sending it, in a box they can still
 * change. Where a writing model is configured it rewrites the draft first,
 * WITH THE CONVERSATION — see `whatsapp-reply-polish.ts` for what it may and
 * may not do to the words — and every version it produces is one Undo away
 * from the one before, with the person's own words always recoverable.
 *
 * The model is a convenience and never a gate. With no key, or a provider that
 * does not answer, the dialog is the same review over the draft as typed, and
 * Send works exactly as well.
 *
 * Mounted with a `key` per opening, so each review starts fresh rather than
 * resetting state in an effect.
 * ------------------------------------------------------------------------- */

const QUICK: Array<{ label: string; instruction: string }> = [
  { label: "Shorter", instruction: "Make it shorter." },
  { label: "More polite", instruction: "Make it more polite and warm." },
  { label: "More formal", instruction: "Make it more formal." },
  { label: "In Hindi", instruction: "Write it in Hindi, in Devanagari script." },
  { label: "In English", instruction: "Write it in English." },
];

export function ReplyReview({
  threadKey,
  customerName,
  draft,
  canPolish,
  onBack,
  onSend,
}: {
  threadKey: string;
  customerName: string;
  /** What was typed in the message box. */
  draft: string;
  /** Whether a writing model is configured — decides whether it is asked at all. */
  canPolish: boolean;
  /** Close without sending; the text goes back into the message box as it now stands. */
  onBack: (text: string) => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = React.useState(draft);
  /** Earlier versions, newest last, for Undo. */
  const [history, setHistory] = React.useState<string[]>([]);
  /** Busy from the first paint where a first improvement is about to be asked for. */
  const [busy, setBusy] = React.useState<string | null>(canPolish ? "Improving the wording…" : null);
  const [error, setError] = React.useState<string | null>(null);
  const [instruction, setInstruction] = React.useState("");
  /** Whether what is in the box came from the model, untouched since. */
  const [fromModel, setFromModel] = React.useState(false);
  const asked = React.useRef(0);

  const ask = React.useCallback(
    async (from: string, mode: "enhance" | "rewrite", how?: string) => {
      const ticket = ++asked.current;
      setBusy(mode === "rewrite" ? "Rewriting…" : "Improving the wording…");
      setError(null);
      const r = await polishChatReply({ key: threadKey, draft: from, mode, instruction: how });
      // A later ask, or the dialog closing, makes this answer stale.
      if (ticket !== asked.current) return;
      setBusy(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.data.text === from) return;
      setHistory((h) => [...h, from]);
      setText(r.data.text);
      setFromModel(true);
    },
    [threadKey],
  );

  // The first improvement is asked for on opening — the reason Send opened this.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (!canPolish || started.current) return;
    started.current = true;
    void ask(draft, "enhance");
    return undefined;
  }, [canPolish, ask, draft]);

  const close = () => {
    asked.current++;
    onBack(text);
  };
  const body = text.trim();
  const send = () => {
    if (!body || busy) return;
    asked.current++;
    onSend(body);
  };
  const rewrite = (how: string) => {
    if (!how.trim() || !body || busy) return;
    void ask(body, "rewrite", how.trim());
  };

  return (
    <Modal
      open
      onClose={close}
      width={600}
      title={<span>Review before sending to {customerName || "this number"}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Back to editing
          </Button>
          <Button variant="primary" onClick={send} disabled={!body || Boolean(busy)} title="Send (Ctrl+Enter)">
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <VoiceTextarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFromModel(false);
            }}
            onDictate={(v) => {
              setText(v);
              setFromModel(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            maxLength={4000}
            rows={Math.min(10, Math.max(4, text.split("\n").length + 1))}
            disabled={Boolean(busy)}
            aria-label="The message to send"
            className="text-[15px]"
          />
          {busy ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-[4px] bg-surface/70 text-sm text-muted">
              {busy}
            </div>
          ) : null}
        </div>

        <p className={cx("text-xs", error ? "text-danger" : "text-muted")}>
          {error
            ? error
            : fromModel
              ? "Rewritten with the conversation in view. Check every number, date and name — it goes from the business number exactly as shown."
              : "This is exactly what will be sent from the business number. Edit it here if anything is wrong."}
        </p>

        {canPolish ? (
          <div className="space-y-2 rounded-[6px] border border-divider p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void ask(body, "enhance")} disabled={!body || Boolean(busy)}>
                {history.length ? "Improve again" : "Improve wording"}
              </Button>
              {QUICK.map((q) => (
                <Button key={q.label} size="sm" variant="ghost" onClick={() => rewrite(q.instruction)} disabled={!body || Boolean(busy)}>
                  {q.label}
                </Button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    rewrite(instruction);
                  }
                }}
                maxLength={500}
                placeholder="Or say how to change it — e.g. mention the bill is attached"
                disabled={Boolean(busy)}
                className="flex-1"
              />
              <Button size="sm" onClick={() => rewrite(instruction)} disabled={!instruction.trim() || !body || Boolean(busy)}>
                Rewrite
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 text-xs">
          {history.length ? (
            <button
              type="button"
              className="cursor-pointer text-brand hover:underline disabled:cursor-default disabled:opacity-50"
              disabled={Boolean(busy)}
              onClick={() => {
                asked.current++;
                setText(history[history.length - 1]);
                setHistory((h) => h.slice(0, -1));
                setFromModel(false);
              }}
            >
              Undo
            </button>
          ) : null}
          {text !== draft ? (
            <button
              type="button"
              className="cursor-pointer text-brand hover:underline disabled:cursor-default disabled:opacity-50"
              disabled={Boolean(busy)}
              onClick={() => {
                asked.current++;
                setHistory((h) => [...h, text]);
                setText(draft);
                setFromModel(false);
              }}
            >
              Use what I typed
            </button>
          ) : null}
          {busy ? (
            <button
              type="button"
              className="cursor-pointer text-muted hover:underline"
              onClick={() => {
                asked.current++;
                setBusy(null);
              }}
            >
              Stop and use what I typed
            </button>
          ) : null}
        </div>

        {text !== draft ? (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">What you typed</summary>
            <p className="mt-1 whitespace-pre-wrap rounded-[4px] bg-black/[0.03] p-2">{draft}</p>
          </details>
        ) : null}
      </div>
    </Modal>
  );
}
