import React from 'react';
import { Animated, Text, View, Pressable } from 'react-native';
import { Presence, useShake } from '../ui/motion';
import { Icon } from '../ui/Icon';
import { SheetChip, SheetError, SheetFooter, SheetTitle, WashInput } from './v3-parts';
import { BottomSheet, Calendar } from '../ui/overlays';
import { color as C, weight } from '../../theme/tokens';
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

  /* A refusal shakes the box that says it, and buzzes `warning`. */
  const refusal = useShake('warning');
  const refuse = (message: string) => {
    setErr(message);
    refusal.shake();
  };

  const save = () => {
    if (!action.trim()) return refuse('Write the next action. Example: "call him about the sample".');
    if (!date) return refuse('Choose the day.');
    if (!ownerId) return refuse('Choose who will do it.');
    onSave({ action: action.trim(), date, ownerId, outcome: outcome.trim() || undefined });
  };

  return (
    <BottomSheet open={open} onClose={onClose} scroll>
      <SheetTitle title="Next action" sub="Every open lead needs one. The stage cannot move without it." />

      <WashInput
        value={action}
        onChangeText={(v) => { setAction(v); setErr(null); }}
        placeholder="Take the sample and show him the finish"
        accessibilityLabel="Action"
        multiline
        style={{ marginTop: 12 }}
      />

      <Pressable
        onPress={() => setCal(true)}
        accessibilityRole="button"
        accessibilityLabel={'On: ' + (date ? dmy(date) : 'pick a day')}
        style={({ pressed }) => ({
          marginTop: 8,
          minHeight: 52,
          borderRadius: 18,
          backgroundColor: pressed ? C.hairline : C.canvas,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 14,
        })}>
        <Icon name="cal" size={18} color={C.primaryDeep} strokeWidth={2} />
        <Text style={[{ fontSize: 15, lineHeight: 21, color: date ? C.ink : C.faint }, weight(date ? 700 : 400)]}>{date ? dmy(date) : 'Pick a day'}</Text>
      </Pressable>

      {/* Opened IN the sheet rather than in a second one on top of it. A
          modal over a modal is a stack somebody has to dismiss twice, and
          the one underneath is the form they were half way through. */}
      <Presence show={cal}>
        <View style={{ marginTop: 10 }}>
          <Calendar
            selected={date ?? ''}
            disabledReason={(iso) => (iso < today ? 'That day has passed.' : null)}
            onPick={(iso) => { setDate(iso); setErr(null); setCal(false); }}
          />
        </View>
      </Presence>

      {/* Who will do it — me, or the lead manager where there is one. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        <SheetChip
          label="Me"
          a11y={meName + ', you'}
          icon={ownerId === meId ? 'person' : undefined}
          on={ownerId === meId}
          onPress={() => { setOwnerId(meId); setErr(null); }}
        />
        {managerId ? (
          <SheetChip
            label={managerName ?? 'Sales manager'}
            a11y={(managerName ?? 'Your sales manager') + ', lead manager'}
            icon={ownerId === managerId ? 'person' : undefined}
            on={ownerId === managerId}
            onPress={() => { setOwnerId(managerId); setErr(null); }}
          />
        ) : null}
      </View>

      <WashInput
        value={outcome}
        onChangeText={setOutcome}
        placeholder="Result you expect (optional)"
        accessibilityLabel="What result you expect. Optional. A quantity, a date, a yes or no"
        style={{ marginTop: 8 }}
      />

      <Presence show={!!err}>
        <Animated.View style={[{ marginTop: 8 }, refusal.style]}>
          <SheetError text={err ?? ''} />
        </Animated.View>
      </Presence>

      <SheetFooter onCancel={onClose} label="Save" onPress={save} />
    </BottomSheet>
  );
}
