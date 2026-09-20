import React from 'react';
import { View, Pressable } from 'react-native';
import { Badge, Choice, PrimaryButton, SecondaryButton, SectionLabel, T } from '../ui/primitives';
import { VoiceField } from '../ui/dictate';
import { BottomSheet } from '../ui/overlays';
import { color as C, radius, weight } from '../../theme/tokens';
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
    <View style={{ marginTop: 20 }}>
      <SectionLabel style={{ marginBottom: 10 }}>Reach out</SectionLabel>

      <View style={{ gap: 8 }}>
        {log.options.map((option) => (
          <ActionRow key={option.action.code} option={option} onPress={() => setActing(option)} />
        ))}
      </View>

      {log.unattributed > 0 ? (
        <T s="caption" style={{ marginTop: 8 }}>
          {plural(log.unattributed, 'earlier contact') +
            ' on this record ' +
            (log.unattributed === 1 ? 'names' : 'name') +
            ' none of these — it was recorded before the app kept which one.'}
        </T>
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
    ? 'Nothing published yet — the office has to publish one'
    : send
      ? option.documents.length === 1
        ? option.documents[0].title
        : plural(option.documents.length, 'document') + ' to choose from'
      : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      /* Disabled rows stay pressable, because the sheet is where the reason is
         written out in full and a row that answers nothing reads as broken. */
      style={{
        minHeight: 56,
        borderWidth: 1,
        borderColor: C.border,
        borderRadius: radius.lg,
        backgroundColor: nothing ? C.hairline : C.surface,
        paddingHorizontal: 14,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
      }}>
      <View style={{ flex: 1 }}>
        <T style={[{ fontSize: 16, color: nothing ? C.muted : C.ink }, weight(600)]}>
          {option.action.label}
        </T>
        {sub ? (
          <T s="caption" style={{ marginTop: 2 }}>
            {sub}
          </T>
        ) : null}
      </View>

      {/* THE COUNT, NEVER A TICK — once and five times are different
          mornings, and the second is a salesman who should be ringing
          rather than posting a sixth brochure. */}
      {option.sent > 0 ? (
        <Badge tone="success">{option.sent === 1 ? 'Sent' : 'Sent ×' + option.sent}</Badge>
      ) : null}
    </Pressable>
  );
}

/**
 * The one question this sheet asks is WHICH DOCUMENT, and it asks it only
 * where there is a choice to make.
 *
 * The library on this phone carries no publication date — the wire sends the
 * id, the title and the category and nothing else — so "the current price
 * list" is a sentence the handset cannot honestly say where two are published.
 * Guessing is the silent failure: the shop gets last quarter's prices and the
 * record says the price list went. Where there is exactly one it is chosen for
 * him and the sheet says which.
 */
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
    ? 'Nothing is published in this category yet, so there is no document to send. Ask the office to publish one.'
    : send && !documentId
      ? 'Say which document went — the record cannot name it a month from now otherwise.'
      : undefined;

  return (
    <BottomSheet open onClose={onClose} scroll>
      <T style={[{ fontSize: 19, lineHeight: 25, letterSpacing: -0.285, color: C.ink }, weight(600)]}>
        {option.action.label}
      </T>
      <T s="caption" style={{ marginTop: 2 }}>
        {option.sent === 0
          ? 'Nothing has gone out under this one yet.'
          : 'This has gone out ' + plural(option.sent, 'time') + ' already.'}
      </T>

      {send ? (
        <View style={{ marginTop: 14 }}>
          <SectionLabel style={{ marginBottom: 6 }}>What goes</SectionLabel>
          {nothing ? (
            <T style={{ fontSize: 15, lineHeight: 22, color: C.muted }}>
              Nothing is published in this category. The office publishes these, and until one is
              there this cannot be recorded as sent — an empty record of a document nobody can name
              is worse than no record.
            </T>
          ) : option.documents.length === 1 ? (
            <T style={{ fontSize: 16, color: C.ink }}>{option.documents[0].title}</T>
          ) : (
            <View style={{ gap: 8 }}>
              {option.documents.map((doc) => (
                <Choice
                  key={doc.id}
                  label={doc.title}
                  selected={documentId === doc.id}
                  onPress={() => setDocumentId(doc.id)}
                />
              ))}
            </View>
          )}
        </View>
      ) : null}

      {/* The dialler, on a call and only where the shop has a number. It is a
          deep link and nothing else: the phone he is holding already makes
          calls, and the app's job is to remember that he made one. */}
      {!send && onDial ? (
        <SecondaryButton label="Ring them now" onPress={onDial} style={{ marginTop: 14 }} />
      ) : null}

      <View style={{ marginTop: 14 }}>
        <SectionLabel style={{ marginBottom: 6 }}>Anything worth saying</SectionLabel>
        <VoiceField
          value={note}
          onChangeText={setNote}
          placeholder="He asked for the 20 litre rate"
          multiline
        />
      </View>

      <PrimaryButton
        label="Record it"
        disabled={Boolean(why)}
        whyDisabled={why}
        onPress={() => {
          if (why) return;
          if (saving.current) return;
          saving.current = true;
          onSave({ documentId, note: note.trim() || null });
        }}
        style={{ marginTop: 16 }}
      />
      <SecondaryButton label="Not now" onPress={onClose} style={{ marginTop: 10 }} />
    </BottomSheet>
  );
}
