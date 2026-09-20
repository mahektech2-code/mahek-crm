import React from 'react';
import { View } from 'react-native';
import { Choice, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../ui/primitives';
import { BottomSheet } from '../ui/overlays';
import { color as C, radius, weight } from '../../theme/tokens';
import type { CodedOption } from '../../engines/funnel';

/**
 * Ten answers, and none of them is a text box.
 *
 * The funnel asks "why" four times — why this suspect is worth pursuing, why
 * they want a sample, why it was lost, why a manager passed a shut gate — and
 * every one of those used to be free text somewhere. Free text answers all
 * four with "good potential" and can be counted by nobody: the question exists
 * to stop somebody promoting a shop they happened to walk past, and an open
 * box is exactly what a person types a full stop into.
 *
 * The note stays, and it is optional. The CODE is what gets counted and the
 * sentence is what gets read by whoever picks the record up next.
 */
export function ReasonSheet({
  open,
  onClose,
  title,
  body,
  options,
  confirmLabel,
  noteLabel,
  notePlaceholder,
  requireNote = false,
  noteRequiredForCode,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body?: string;
  options: readonly CodedOption[];
  confirmLabel: string;
  noteLabel?: string;
  notePlaceholder?: string;
  requireNote?: boolean;
  /**
   * ONE CODE MAY COST A SENTENCE WHERE THE OTHERS DO NOT.
   *
   * `requireNote` is all-or-nothing and says nothing about WHICH answer was
   * picked. Mahek's lists each end in "Other", and that one answer — a code
   * meaning "something else" with nothing behind it — is the single row nobody
   * can act on afterwards, so it is the one that has to be paid for. Naming
   * the code here rather than turning `requireNote` on demands the sentence
   * exactly where the office demands it and nowhere else, which is what keeps
   * the seven ordinary answers from teaching people to type a full stop.
   */
  noteRequiredForCode?: string;
  onConfirm: (code: string, note: string) => void;
}) {
  /* Remounted by the caller's `key` when it opens rather than reset in an
     effect — the React Compiler rules are on and every drawer in this app
     does it the same way. */
  const [code, setCode] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);

  /*
   * NOTHING TO PICK IS A REAL STATE, and it used to be a dead end.
   *
   * The four lists are configuration and an office can legitimately empty one.
   * `options.map` over an empty array drew no chips at all, so the sheet became
   * a title, a note box and a button that could only ever answer "Pick one" —
   * and on the forced Suspect decision, where the whole record is replaced by
   * this question, neither answer could complete and the lead was stuck for
   * good.
   *
   * So where there is nothing to pick, the sentence IS the answer. The server
   * agrees: `handleLeadUpdate` refuses a loss with neither a reason code nor a
   * sentence, and accepts either. The code stays empty rather than being
   * invented out of the note — a stored label is the one thing §26 forbids.
   */
  const nothingToPick = options.length === 0;

  /*
   * THE REFUSAL IS STATED BEFORE THE BUTTON IS PRESSED, not after it.
   *
   * Everything else on this sheet answers on the press, because until somebody
   * has picked there is nothing to say. A code that demands a sentence is
   * different: the moment "Other" is chosen the screen knows exactly what is
   * still owed, and holding that back until the press teaches somebody the app
   * refuses things at random. Only the CODE-driven demand is drawn this way —
   * `requireNote` and the nothing-to-pick case answer on the press as they
   * always have, because widening this would move the behaviour of four other
   * screens that never asked for it.
   */
  const codeDemandsNote = noteRequiredForCode !== undefined && code === noteRequiredForCode;
  const missing =
    codeDemandsNote && !note.trim()
      ? 'Say what happened — “Other” with nothing behind it is the one answer nobody can act on.'
      : null;

  const confirm = () => {
    if (!code && !nothingToPick) return setErr('Pick one — it is what gets counted afterwards.');
    if (missing) return setErr(missing);
    if ((requireNote || nothingToPick) && !note.trim()) {
      return setErr('A sentence, so whoever reads this next knows what happened.');
    }
    onConfirm(code ?? '', note.trim());
  };

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>{title}</T>
      {body ? <T s="caption" style={{ marginTop: 2 }}>{body}</T> : null}

      {nothingToPick ? (
        <View style={{ marginTop: 14, backgroundColor: C.wash, borderRadius: radius.lg, padding: 12 }}>
          <T style={{ fontSize: 14, lineHeight: 20, color: C.body }}>
            Your office has not set any reasons to pick from yet — tell them. Write what happened below and this will
            still save.
          </T>
        </View>
      ) : (
        <View style={{ gap: 8, marginTop: 14 }}>
          {options.map((o) => (
            <Choice
              key={o.code}
              label={o.label}
              selected={code === o.code}
              onPress={() => { setCode(o.code); setErr(null); }}
              style={{ alignItems: 'flex-start', paddingHorizontal: 14 }}
            />
          ))}
        </View>
      )}

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>
          {(noteLabel ?? 'Anything to add') + (codeDemandsNote ? ' · required' : '')}
        </SectionLabel>
        <Input
          value={note}
          onChangeText={(v) => { setNote(v); setErr(null); }}
          placeholder={
            nothingToPick || codeDemandsNote
              ? 'What happened, in your own words'
              : notePlaceholder ?? 'Optional — what they actually said'
          }
          multiline
        />
      </View>

      {err ? (
        <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        {/* Still pressable with a reason on it, which is the house rule for
            every disabled button here: a tap that answers teaches somebody
            what is missing, and one that swallows the press teaches them the
            screen is broken. */}
        <PrimaryButton
          label={confirmLabel}
          onPress={confirm}
          disabled={Boolean(missing)}
          whyDisabled={missing ?? undefined}
          style={{ flex: 1, borderRadius: radius.xl }}
        />
      </View>
    </BottomSheet>
  );
}
