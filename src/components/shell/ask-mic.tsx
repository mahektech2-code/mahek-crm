"use client";

import * as React from "react";
import { DictateButton, MicIcon } from "@/components/ui/dictate";
import type { AskVoice } from "@/lib/ask-voice";

/* ---------------------------------------------------------------------------
 * ASK BY SPEAKING — the dictation microphone, beside every Ask AI box.
 *
 * It is the telecallers' microphone (`components/ui/dictate.tsx`), not a
 * second one: the same recording, the same Sarvam-then-OpenAI hearing, the
 * same window that shows the English before anything happens and keeps what
 * was heard one click away. The only differences are the words on its
 * button — "Ask this" rather than "Put it in the box" — and that the question
 * is asked the moment it is accepted.
 *
 * What was SAID travels with the English (`AskVoice`), and the server tells
 * the assistant to answer in that language — the point is that somebody who
 * does not read English can ask in Hindi or Marathi and read the answer.
 *
 * Draws nothing where dictation is off, unconfigured, or the browser cannot
 * record — the same rule as every other microphone here.
 * ------------------------------------------------------------------------- */

export function AskMic({
  onAsk,
  disabled,
}: {
  onAsk: (english: string, voice: AskVoice) => void;
  disabled?: boolean;
}) {
  return (
    <DictateButton
      modalTitle="Ask by speaking"
      importLabel="Ask this"
      title="Ask by speaking, in any language — the answer comes back in it"
      onImport={(text, _replace, meta) => onAsk(text, { spoken: meta.spoken, language: meta.language })}
      renderTrigger={(open) => (
        <button
          type="button"
          onClick={open}
          disabled={disabled}
          aria-label="Ask by speaking, in any language"
          title="Ask by speaking, in any language — the answer comes back in it"
          className="flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-[6px] border border-brand-softer bg-brand-soft text-brand transition-colors duration-100 hover:border-brand hover:bg-brand-softer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <MicIcon size={16} />
        </button>
      )}
    />
  );
}

/** A spoken question's bubble: what they said, and the English it was read as. */
export function SpokenQuestion({ spoken, english }: { spoken: string; english: string }) {
  return (
    <>
      <span className="flex items-start gap-1.5">
        <span className="mt-0.5 flex flex-none text-brand" aria-label="Asked by voice">
          <MicIcon size={12} />
        </span>
        <span>{spoken}</span>
      </span>
      {english.trim() && english.trim() !== spoken.trim() ? (
        <span className="mt-1 block text-[12px] leading-4 text-muted">Read as: {english}</span>
      ) : null}
    </>
  );
}
