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
  onConfirm: (code: string, note: string) => void;
}) {
  /* Remounted by the caller's `key` when it opens rather than reset in an
     effect — the React Compiler rules are on and every drawer in this app
     does it the same way. */
  const [code, setCode] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);

  const confirm = () => {
    if (!code) return setErr('Pick one — it is what gets counted afterwards.');
    if (requireNote && !note.trim()) return setErr('A sentence, so whoever reads this next knows what happened.');
    onConfirm(code, note.trim());
  };

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>{title}</T>
      {body ? <T s="caption" style={{ marginTop: 2 }}>{body}</T> : null}

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

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>{noteLabel ?? 'Anything to add'}</SectionLabel>
        <Input
          value={note}
          onChangeText={(v) => { setNote(v); setErr(null); }}
          placeholder={notePlaceholder ?? 'Optional — what they actually said'}
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
        <PrimaryButton label={confirmLabel} onPress={confirm} style={{ flex: 1, borderRadius: radius.xl }} />
      </View>
    </BottomSheet>
  );
}
