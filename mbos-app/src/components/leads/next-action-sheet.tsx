import React from 'react';
import { View, Pressable } from 'react-native';
import { Choice, Input, PrimaryButton, SecondaryButton, SectionLabel, T } from '../ui/primitives';
import { BottomSheet, Calendar } from '../ui/overlays';
import { color as C, radius, weight } from '../../theme/tokens';
import { dmy, isoDate } from '../../lib/format';

/**
 * §24 — what happens next, on what day, and who is doing it.
 *
 * Three answers, and the save does not close until it has all three. A next
 * action with a date and no owner is the exact state this rule exists to stop:
 * a lead sitting for six weeks looking attended to, with everybody assuming
 * somebody else has it.
 *
 * Two owners are offered and no more, because those are the two people a
 * handset knows about — the salesman holding it, and the lead manager the
 * office put on this lead at Prospect. There is no picker of the whole company
 * here: a salesman cannot hand his work to somebody he has never met, and a
 * list that let him would be a list he picked the first name from.
 */
export function NextActionSheet({
  open,
  onClose,
  meId,
  meName,
  managerId,
  managerName,
  current,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  meId: string;
  meName: string;
  managerId?: string | null;
  managerName?: string | null;
  current?: { action: string | null; date: string | null; ownerId: string | null } | null;
  onSave: (next: { action: string; date: string; ownerId: string; outcome?: string }) => void;
}) {
  const [action, setAction] = React.useState(current?.action ?? '');
  const [date, setDate] = React.useState<string | null>(current?.date ?? null);
  const [ownerId, setOwnerId] = React.useState(current?.ownerId ?? meId);
  const [outcome, setOutcome] = React.useState('');
  const [cal, setCal] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [today] = React.useState(() => isoDate(new Date()));

  const save = () => {
    if (!action.trim()) return setErr('Say what happens next — "ring him about the trial", not "follow up".');
    if (!date) return setErr('Pick the day it happens on.');
    if (!ownerId) return setErr('Say who is doing it.');
    onSave({ action: action.trim(), date, ownerId, outcome: outcome.trim() || undefined });
  };

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
        What happens next
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        Every lead being worked owes one. Nothing moves up a rung without it.
      </T>

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>The action</SectionLabel>
        <Input
          value={action}
          onChangeText={(v) => { setAction(v); setErr(null); }}
          placeholder="Take the sample round and show him the finish"
          multiline
        />
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>On</SectionLabel>
        <Pressable
          onPress={() => setCal(true)}
          accessibilityRole="button"
          style={{
            minHeight: 52,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: radius.lg,
            backgroundColor: C.surface,
            justifyContent: 'center',
            paddingHorizontal: 14,
          }}>
          <T style={{ fontSize: 16, color: date ? C.ink : C.faint }}>{date ? dmy(date) : 'Pick a day'}</T>
        </Pressable>

        {/* Opened IN the sheet rather than in a second one on top of it. A
            modal over a modal is a stack somebody has to dismiss twice, and
            the one underneath is the form they were half way through. */}
        {cal ? (
          <View style={{ marginTop: 10 }}>
            <Calendar
              selected={date ?? ''}
              disabledReason={(iso) => (iso < today ? 'That day has gone.' : null)}
              onPick={(iso) => { setDate(iso); setErr(null); setCal(false); }}
            />
          </View>
        ) : null}
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Who is doing it</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Choice
            label={meName}
            sub="You"
            selected={ownerId === meId}
            onPress={() => { setOwnerId(meId); setErr(null); }}
            style={{ paddingHorizontal: 14 }}
          />
          {managerId ? (
            <Choice
              label={managerName ?? 'Your sales manager'}
              sub="Lead manager"
              selected={ownerId === managerId}
              onPress={() => { setOwnerId(managerId); setErr(null); }}
              style={{ paddingHorizontal: 14 }}
            />
          ) : null}
        </View>
      </View>

      <View style={{ marginTop: 12 }}>
        <SectionLabel style={{ marginBottom: 6 }}>What you expect to come back with</SectionLabel>
        <Input
          value={outcome}
          onChangeText={setOutcome}
          placeholder="Optional — a quantity, a date, a yes or a no"
        />
      </View>

      {err ? (
        <View style={{ marginTop: 12, backgroundColor: C.dangerBg, borderRadius: radius.lg, padding: 12 }}>
          <T style={[{ fontSize: 14, lineHeight: 20, color: C.danger }, weight(500)]}>{err}</T>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
        <SecondaryButton label="Cancel" onPress={onClose} style={{ flex: 1, borderRadius: radius.xl }} />
        <PrimaryButton label="Save it" onPress={save} style={{ flex: 1, borderRadius: radius.xl }} />
      </View>
    </BottomSheet>
  );
}
