import React from 'react';
import { View, Pressable, Text } from 'react-native';
import { PrimaryButton } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { SheetChip, SheetTitle } from './v3-parts';
import { VoiceField } from '../ui/dictate';
import { BottomSheet } from '../ui/overlays';
import { color as C, weight } from '../../theme/tokens';
import { plural } from '../../lib/format';
import type { CommunicationLog, CommunicationOption } from '../../data/lead-communication';

/**
 * §10.4 — the eleven buttons, on the handset, driven from the list.
 *
 * `COMMUNICATION_ACTIONS` is the authority on what they are and which library
 * category each `send` reaches for; `data/lead-communication.ts` is the one
 * place it is read. Writing eleven rows into this file would be the same
 * mistake as a product list typed into a screen, and the copy that drifts is
 * always the one somebody is looking at.
 *
 * **BOTH KINDS ARE RECORDED.** A call logged and a file sent are the same
 * fact — somebody reached out on a day — and the value of the record is seeing
 * both against a lead that has gone quiet. Recording only the sends would make
 * a lead rung four times read as untouched.
 *
 * **A SEND WITH NOTHING PUBLISHED IS DISABLED AND SAYS SO.** A control that
 * dies when pressed teaches people to stop pressing, and there would be
 * nothing on the screen naming the fix — which is that somebody in the office
 * has to publish one. The reason rides on `whyDisabled`, so pressing it
 * answers rather than swallowing the tap.
 */
export function CommunicationPanel({
  log,
  onRecord,
  /** Offered beside a `call` action where the shop has a number. */
  onDial,
}: {
  log: CommunicationLog;
  onRecord: (args: { actionCode: string; documentId: string | null; note: string | null }) => void;
  onDial?: () => void;
}) {
  /* One piece of state rather than a boolean and a payload: a sheet that can
     be open with no action behind it is a state this screen has no answer
     for, and the `key` below is what remounts it fresh rather than an effect
     resetting its fields, which the React Compiler rules forbid. */
  const [acting, setActing] = React.useState<CommunicationOption | null>(null);

  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 22, padding: 16 }}>
      <Text accessibilityRole="header" style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(800)]}>
        Contact them
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {log.options.map((option) => (
          <ActionRow key={option.action.code} option={option} onPress={() => setActing(option)} />
        ))}
      </View>

      {log.unattributed > 0 ? (
        <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 10 }, weight(400)]}>
          {plural(log.unattributed, 'earlier contact') +
            ' on this lead ' +
            (log.unattributed === 1 ? 'is' : 'are') +
            ' not in this list. It was saved before the app kept the type.'}
        </Text>
      ) : null}

      {acting ? (
        <RecordSheet
          key={acting.action.code}
          option={acting}
          onDial={onDial}
          onClose={() => setActing(null)}
          onSave={(args) => {
            setActing(null);
            onRecord({ actionCode: acting.action.code, ...args });
          }}
        />
      ) : null}
    </View>
  );
}

/** One of the eleven, with what it would send and what has already gone. */
function ActionRow({ option, onPress }: { option: CommunicationOption; onPress: () => void }) {
  const send = option.action.kind === 'send';
  const nothing = send && option.documents.length === 0;
  const sub = nothing
    ? 'Nothing here yet. The office must add one'
    : send
      ? option.documents.length === 1
        ? option.documents[0].title
        : plural(option.documents.length, 'document') + ' to choose from'
      : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        option.action.label +
        (sub ? '. ' + sub : '') +
        (option.sent > 0 ? '. ' + (option.sent === 1 ? 'Sent' : 'Sent ' + option.sent + ' times') : '')
      }
      /* Disabled rows stay pressable, because the sheet is where the reason is
         written out in full and a row that answers nothing reads as broken. */
      style={({ pressed }) => ({
        flexGrow: 1,
        flexBasis: '45%',
        minHeight: 60,
        borderRadius: 16,
        borderWidth: nothing ? 1 : 0,
        borderStyle: 'dashed',
        borderColor: C.border,
        backgroundColor: nothing ? '#F4F6FA' : pressed ? C.hairline : C.canvas,
        paddingLeft: 12,
        paddingRight: option.sent > 0 ? 30 : 12,
        paddingVertical: 10,
        justifyContent: 'center',
      })}>
      <Text style={[{ fontSize: 13, lineHeight: 17, color: nothing ? C.faint : C.ink }, weight(700)]}>
        {option.action.label}
      </Text>
      {sub ? (
        <Text numberOfLines={1} style={[{ fontSize: 11, lineHeight: 15, color: nothing ? C.faint : C.muted }, weight(400)]}>
          {nothing ? 'Office must add one' : sub}
        </Text>
      ) : null}

      {/* THE COUNT, NEVER A TICK ALONE — once and five times are different
          mornings, and the second is a salesman who should be ringing
          rather than posting a sixth brochure. */}
      {option.sent > 0 ? (
        <Text style={[{ position: 'absolute', right: 8, top: 8, fontSize: 10, color: C.success }, weight(700)]}>
          {option.sent === 1 ? '✓' : '✓×' + option.sent}
        </Text>
      ) : null}
    </Pressable>
  );
}

function RecordSheet({
  option,
  onClose,
  onSave,
  onDial,
}: {
  option: CommunicationOption;
  onClose: () => void;
  onSave: (args: { documentId: string | null; note: string | null }) => void;
  onDial?: () => void;
}) {
  const send = option.action.kind === 'send';
  const [documentId, setDocumentId] = React.useState<string | null>(
    send && option.documents.length === 1 ? option.documents[0].id : null,
  );
  const [note, setNote] = React.useState('');
  /* A ref and not state, for the reason every other sheet in this app gives:
     a second press lands before React has re-rendered, reads the old `false`
     from its own closure, and records the same contact twice. */
  const saving = React.useRef(false);

  const nothing = send && option.documents.length === 0;
  const why = nothing
    ? 'No document here yet, so nothing to send. Ask the office to add one.'
    : send && !documentId
      ? 'Choose which document you sent.'
      : undefined;

  return (
    <BottomSheet open onClose={onClose} scroll>
      <SheetTitle
        title={option.action.label}
        sub={option.sent === 0 ? 'Not sent yet' : 'Already sent ' + plural(option.sent, 'time')}
        lead={<Icon name={send ? 'doc' : 'call'} size={22} color={C.primaryDeep} strokeWidth={2} />}
      />

      {send ? (
        <View style={{ marginTop: 12 }}>
          {nothing ? (
            <Text style={[{ fontSize: 14, lineHeight: 20, color: C.muted }, weight(400)]}>
              No document here yet. The office adds these. Until then you cannot save it as sent.
            </Text>
          ) : option.documents.length === 1 ? (
            <Text accessibilityLabel={'What you send: ' + option.documents[0].title} style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>
              {option.documents[0].title}
            </Text>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {option.documents.map((doc) => (
                <SheetChip key={doc.id} label={doc.title} on={documentId === doc.id} onPress={() => setDocumentId(doc.id)} />
              ))}
            </View>
          )}
        </View>
      ) : null}

      {/* The dialler, on a call and only where the shop has a number. It is a
          deep link and nothing else: the phone he is holding already makes
          calls, and the app's job is to remember that he made one. */}
      {!send && onDial ? (
        <Pressable
          onPress={onDial}
          accessibilityRole="button"
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            marginTop: 10,
            minHeight: 44,
            paddingHorizontal: 16,
            borderRadius: 22,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: pressed ? C.primaryEdge : C.primaryTint,
          })}>
          <Icon name="call" size={16} color={C.primaryDeep} strokeWidth={2} />
          <Text style={[{ fontSize: 13, lineHeight: 18, color: C.primaryDeep }, weight(700)]}>Call now</Text>
        </Pressable>
      ) : null}

      <View style={{ marginTop: 10 }}>
        <VoiceField
          value={note}
          onChangeText={setNote}
          placeholder="Note (optional) — he asked for the 20 litre rate"
          multiline
          style={{ borderRadius: 18, backgroundColor: C.canvas, borderWidth: 0 }}
        />
      </View>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={({ pressed }) => ({ width: 110, minHeight: 56, paddingVertical: 8, borderRadius: 28, backgroundColor: pressed ? C.hairline : C.canvas, alignItems: 'center', justifyContent: 'center' })}>
          <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>Not now</Text>
        </Pressable>
        <PrimaryButton
          label="Save"
          tone="navy"
          disabled={Boolean(why)}
          whyDisabled={why}
          onPress={() => {
            if (why) return;
            if (saving.current) return;
            saving.current = true;
            onSave({ documentId, note: note.trim() || null });
          }}
          style={{ flex: 1, borderRadius: 28 }}
        />
      </View>
    </BottomSheet>
  );
}
