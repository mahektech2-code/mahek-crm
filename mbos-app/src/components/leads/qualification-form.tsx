import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { PrimaryButton } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { HERO } from '../shell/Chrome';
import { color as C, weight } from '../../theme/tokens';
import { saveProspectFields, saveQualification, type LeadFunnelView } from '../../data/lead-funnel';
import {
  QUALIFICATION_ANSWER_KEYS,
  QUALIFICATION_CONDITIONS,
  gateTo,
  qualificationAnswerFault,
  type LeadGateInput,
} from '../../engines/funnel';
import { plural } from '../../lib/format';
import { cleanWhole, parseWhole } from '../../lib/decimal-input';
import { useStore } from '../../state/store';

/**
 * The shop's Qualification — the Salesman's eight questions.
 *
 * He collects every answer here, standing in the shop; the Sales Manager the
 * lead is under validates the GST number and reviews the rest. He never
 * approves anything and this screen draws nothing that looks like approval.
 *
 * EVERY QUESTION IS A STORED ANSWER, not a switch. The gate reads the value, so
 * a row cannot read "done" over an empty box. Four answers live on the lead's own
 * columns (GST number, application, credit days, decision maker) and the rest in
 * the `qualification` object under `QUALIFICATION_ANSWER_KEYS`; where each lands
 * is `store` below.
 *
 * "Done" on a row is asked of the SAME engine the office refuses on
 * (`gateTo(…, 'sample_trial')`), over what is in the boxes in front of him. The
 * header count reads what has been KEPT, so it does not move until he has pressed
 * Save and cannot report answers the database has never seen.
 *
 * It saves on the phone first and is sent when there is signal.
 */

type FieldKind = 'text' | 'long' | 'int' | 'yesno' | 'choice' | 'date';

type Field = {
  /** The key in the draft — a lead column's name, or a `QUALIFICATION_ANSWER_KEYS` entry. */
  key: string;
  label: string;
  hint?: string;
  kind: FieldKind;
  /** Where the answer lands. */
  store: 'prospect' | 'answer';
  options?: { value: string; label: string }[];
};

type Section = { id: string; title: string; fields: Field[] };

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const SECTIONS: Section[] = [
  {
    id: 'gst_verified',
    title: 'GST number',
    fields: [
      {
        key: 'gstin',
        label: 'GST number',
        hint: '15 characters, as printed. Your Sales Manager checks it when she reviews.',
        kind: 'text',
        store: 'prospect',
      },
    ],
  },
  {
    id: 'application_understood',
    title: 'What they will use it on',
    fields: [{ key: 'application', label: 'Application', kind: 'long', store: 'prospect' }],
  },
  {
    id: 'trial_plan',
    title: 'The trial',
    fields: [
      { key: 'trial_product', label: 'Product', hint: 'What we are sending for the trial', kind: 'text', store: 'answer' },
      { key: 'trial_pack', label: 'Pack size', hint: 'For example 20 L', kind: 'text', store: 'answer' },
      { key: 'trial_quantity', label: 'Sample quantity', hint: 'For example 2 cans', kind: 'text', store: 'answer' },
      { key: 'trial_tester', label: 'Who will test it', kind: 'text', store: 'answer' },
      { key: 'trial_duration', label: 'Expected trial duration', hint: 'For example 7 days', kind: 'text', store: 'answer' },
    ],
  },
  {
    id: 'people_identified',
    title: 'Who decides, who orders, who pays',
    fields: [
      { key: 'decisionMaker', label: 'Who decides', kind: 'text', store: 'prospect' },
      { key: 'decision_maker_phone', label: 'Their phone (optional)', kind: 'text', store: 'answer' },
      { key: 'buyer_same', label: 'Does the same person place the order?', kind: 'yesno', store: 'answer' },
      { key: 'buyer_name', label: 'Who places the order', hint: 'Only if it is somebody else', kind: 'text', store: 'answer' },
      { key: 'buyer_phone', label: "Buyer's phone (optional)", kind: 'text', store: 'answer' },
      { key: 'payer_same', label: 'Does the same person pay?', kind: 'yesno', store: 'answer' },
      { key: 'payer', label: 'Who pays', hint: 'Only if it is somebody else', kind: 'text', store: 'answer' },
      { key: 'payer_phone', label: "Payer's phone (optional)", kind: 'text', store: 'answer' },
    ],
  },
  {
    id: 'price_and_credit',
    title: 'Price and credit',
    fields: [
      { key: 'price_range', label: 'Price or range discussed', kind: 'text', store: 'answer' },
      { key: 'creditDaysWanted', label: 'Credit days they asked for', hint: 'Days, 0 to 365', kind: 'int', store: 'prospect' },
      {
        key: 'price_reaction',
        label: 'How they took it',
        kind: 'choice',
        store: 'answer',
        options: [
          { value: 'accepted', label: 'Accepted' },
          { value: 'negotiating', label: 'Negotiating' },
          { value: 'objecting', label: 'Objecting' },
        ],
      },
    ],
  },
  {
    id: 'delivery_workable',
    title: 'Delivery',
    fields: [
      { key: 'delivery_location', label: 'Where we deliver', kind: 'text', store: 'answer' },
      { key: 'delivery_lead_time', label: 'Lead time you quoted', hint: 'For example 3 days', kind: 'text', store: 'answer' },
      { key: 'delivery_suits', label: 'Does that timing suit them?', kind: 'yesno', store: 'answer' },
    ],
  },
  {
    id: 'willing_to_test',
    title: 'Still willing to test',
    fields: [
      {
        key: 'willing_to_test',
        label: 'Will they still test it?',
        hint: 'Ask this after price, credit and delivery. Only a yes passes.',
        kind: 'yesno',
        store: 'answer',
      },
    ],
  },
  {
    id: 'next_step_dated',
    title: 'If the trial goes well',
    fields: [
      { key: 'next_step', label: 'What happens next', kind: 'long', store: 'answer' },
      { key: 'next_step_date', label: 'By when', hint: 'YYYY-MM-DD', kind: 'date', store: 'answer' },
    ],
  },
];

const ANSWER_KEYS = new Set<string>(QUALIFICATION_ANSWER_KEYS);

/** Qualification is the live job at these rungs only; the Sales Manager's verification opens it. */
const WORKING_STAGES = ['qualification', 'qualified'];

/** Everything on screen as a string, from what is saved. */
function initialDraft(view: LeadFunnelView): Record<string, string> {
  const { lead, input } = view;
  const draft: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text) draft[key] = text;
  };
  put('gstin', lead.gstin);
  put('application', lead.application);
  put('decisionMaker', lead.decisionMaker);
  put('creditDaysWanted', lead.creditDaysWanted);
  for (const [key, value] of Object.entries(input.qualification ?? {})) {
    if (ANSWER_KEYS.has(key) && typeof value === 'string') put(key, value);
  }
  return draft;
}

/** The gate's input with the boxes on screen laid over what is saved. */
function liveInput(base: LeadGateInput, draft: Record<string, string>): LeadGateInput {
  const qualification: Record<string, boolean | string> = { ...(base.qualification ?? {}) };
  for (const key of ANSWER_KEYS) {
    if (key in draft) qualification[key] = draft[key];
  }
  const credit = parseWhole(draft.creditDaysWanted ?? '');
  return {
    ...base,
    gstin: 'gstin' in draft ? draft.gstin : base.gstin,
    application: 'application' in draft ? draft.application : base.application,
    decisionMaker: 'decisionMaker' in draft ? draft.decisionMaker : base.decisionMaker,
    creditDaysWanted: 'creditDaysWanted' in draft ? credit : base.creditDaysWanted,
    qualification,
  };
}

/** Which of the eight are still open, asked of the engine. The GST row is "answered" once the number is there: validating it is the Sales Manager's. */
function openRows(input: LeadGateInput): Set<string> {
  const missing = new Set(gateTo(input, 'sample_trial').missing.map((c) => c.id));
  if ((input.gstin ?? '').trim()) missing.delete('gst_verified');
  return missing;
}

export function QualificationForm({
  view,
  onSaved,
  frame,
}: {
  view: LeadFunnelView;
  onSaved: () => void;
  /** The route draws the count and the bars in its lavender hero, as V3
      does; the counts live here, so the form fills both halves. */
  frame?: (parts: { hero: React.ReactNode; body: React.ReactNode }) => React.ReactElement;
}) {
  const notify = useStore((s) => s.notify);
  const { lead, input } = view;
  const [draft, setDraft] = React.useState<Record<string, string>>(() => initialDraft(view));
  const [busy, setBusy] = React.useState(false);

  const writable = WORKING_STAGES.includes(view.stage);
  const kept = React.useMemo(() => openRows(input), [input]);
  const live = React.useMemo(() => openRows(liveInput(input, draft)), [input, draft]);
  const total = QUALIFICATION_CONDITIONS.length;
  const done = QUALIFICATION_CONDITIONS.filter((c) => !kept.has(c.id)).length;
  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const validated = lead.gstVerified === 1;

  const save = async () => {
    setBusy(true);
    try {
      /* A value the gate cannot read is told to him here, in words, rather than
         dropped at the office a minute after he has left the shop. */
      for (const section of SECTIONS) {
        for (const f of section.fields) {
          if (f.store !== 'answer') continue;
          const fault = qualificationAnswerFault(f.key, draft[f.key] ?? '');
          if (fault) return notify(`${f.label}: ${fault}`, 'warn');
        }
      }

      /* Only what was TOUCHED is sent, and an emptied box clears the answer. */
      const prospect: {
        gstin?: string | null;
        application?: string | null;
        decisionMaker?: string | null;
        creditDaysWanted?: number | null;
      } = {};
      const text = (key: string) => (draft[key] ?? '').trim();
      if ('gstin' in draft) prospect.gstin = text('gstin') || null;
      if ('application' in draft) prospect.application = text('application') || null;
      if ('decisionMaker' in draft) prospect.decisionMaker = text('decisionMaker') || null;
      if ('creditDaysWanted' in draft) {
        const days = parseWhole(text('creditDaysWanted'));
        prospect.creditDaysWanted = days == null ? null : Math.min(365, days);
      }
      const answers: Record<string, string> = {};
      for (const key of ANSWER_KEYS) {
        if (key in draft) answers[key] = draft[key].trim();
      }

      if (Object.keys(prospect).length) {
        const r = await saveProspectFields(lead.id, prospect);
        if (!r.ok) return notify(r.message, 'warn');
      }
      if (Object.keys(answers).length) {
        const r = await saveQualification(lead.id, answers);
        if (!r.ok) return notify(r.message, 'warn');
      }
      onSaved();
      notify('Qualification saved');
    } finally {
      setBusy(false);
    }
  };

  const hero = (
    <View style={{ marginTop: 14 }}>
      <Text style={[{ fontSize: 13, lineHeight: 18, color: HERO.lavender.muted }, weight(600)]}>Qualification</Text>
      <Text accessibilityRole="header" style={[{ fontSize: 24, lineHeight: 30, letterSpacing: -0.4, color: HERO.lavender.ink }, weight(800)]}>
        {lead.company?.trim() || lead.name}
      </Text>
      <View accessible accessibilityLabel={done + ' of ' + total + ' answered'} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 12 }}>
        <Text style={[{ fontSize: 34, lineHeight: 40, letterSpacing: -0.6, color: HERO.lavender.ink }, weight(800)]}>{String(done)}</Text>
        <Text style={[{ fontSize: 15, lineHeight: 21, color: HERO.lavender.muted }, weight(700)]}>{'of ' + total + ' answered'}</Text>
      </View>
      {/* One bar a question, filled where the SAVED answer counts — the bars
          read the record, like the count, so they move on Save. */}
      <View style={{ flexDirection: 'row', gap: 4, marginTop: 8 }}>
        {SECTIONS.map((sec) => (
          <View key={sec.id} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: kept.has(sec.id) ? C.primaryEdge : C.primary }} />
        ))}
      </View>
      <Text style={[{ fontSize: 12, lineHeight: 17, color: HERO.lavender.muted, marginTop: 8 }, weight(400)]}>
        {done === total
          ? 'All saved. Your Sales Manager validates the GST number and reviews the rest.'
          : plural(total - done, 'question') + ' left. Only saved answers count. Press Save to keep them all.'}
      </Text>
    </View>
  );

  const body = (
    <View style={{ gap: 10 }}>
      {!writable ? (
        <View style={{ backgroundColor: C.warnBg, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', gap: 8 }}>
          <Icon name="lock" size={16} color={C.warnInk} strokeWidth={2.2} />
          <Text style={[{ flex: 1, fontSize: 13, lineHeight: 19, color: C.warnInk }, weight(600)]}>
            Qualification opens once your Sales Manager has verified this Prospect. Until then there is nothing to answer here.
          </Text>
        </View>
      ) : null}

      {SECTIONS.map((section, i) => {
        const open = live.has(section.id);
        const inline = section.fields.length === 1 && section.fields[0].kind === 'yesno';
        return (
          <View key={section.id} style={{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View
                accessible
                accessibilityLabel={open ? 'Not yet' : 'Done'}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: open ? 'transparent' : C.success,
                  borderWidth: open ? 2 : 0,
                  borderColor: C.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                {open ? (
                  <Text style={[{ fontSize: 12, color: C.faint }, weight(800)]}>{String(i + 1)}</Text>
                ) : (
                  <Icon name="tick" size={15} color="#FFFFFF" strokeWidth={2.6} />
                )}
              </View>
              <Text accessibilityRole="header" style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>
                {(open ? '' : i + 1 + ' · ') + section.title}
              </Text>
              {inline ? <YesNo field={section.fields[0]} value={draft[section.fields[0].key]} writable={writable} onSet={set} /> : null}
            </View>

            {inline ? (
              section.fields[0].hint ? (
                <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 6 }, weight(400)]}>{section.fields[0].hint}</Text>
              ) : null
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {section.fields.map((f) =>
                  f.kind === 'yesno' || f.kind === 'choice' ? (
                    <View key={f.key} style={{ flexBasis: '100%', flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {f.kind === 'yesno' ? (
                        <Text style={[{ flex: 1, minWidth: 120, fontSize: 13, lineHeight: 18, color: C.ink }, weight(400)]}>{f.label}</Text>
                      ) : null}
                      <YesNo field={f} value={draft[f.key]} writable={writable} onSet={set} />
                    </View>
                  ) : (
                    <View key={f.key} style={{ flexGrow: 1, flexBasis: f.kind === 'long' || section.fields.length === 1 ? '100%' : '45%' }}>
                      <View style={{ minHeight: f.kind === 'long' ? 56 : 52, borderRadius: 16, backgroundColor: C.canvas, paddingHorizontal: 14, paddingVertical: 6 }}>
                        {section.fields.length > 1 ? (
                          <Text style={[{ fontSize: 11, lineHeight: 15, color: C.faint }, weight(400)]}>{f.label}</Text>
                        ) : null}
                        <TextInput
                          value={draft[f.key] ?? ''}
                          editable={writable}
                          onChangeText={(v) => set(f.key, f.kind === 'int' ? cleanWhole(v) : v)}
                          placeholder={f.kind === 'date' ? 'YYYY-MM-DD' : section.fields.length > 1 ? '' : f.label}
                          placeholderTextColor={C.faint}
                          accessibilityLabel={f.label + (f.hint ? '. ' + f.hint : '')}
                          keyboardType={f.kind === 'int' ? 'number-pad' : 'default'}
                          multiline={f.kind === 'long'}
                          style={[{ fontSize: 14, lineHeight: 19, color: C.ink, paddingVertical: 4, paddingHorizontal: 0, textAlignVertical: f.kind === 'long' ? 'top' : 'center' }, weight(400)]}
                        />
                      </View>
                      {f.kind === 'int' && (draft[f.key] ?? '').includes('.') ? (
                        <Text style={[{ fontSize: 12, lineHeight: 16, color: C.danger, marginTop: 3 }, weight(400)]}>Whole days only.</Text>
                      ) : null}
                      {f.hint && section.id !== 'gst_verified' ? (
                        <Text style={[{ fontSize: 11, lineHeight: 15, color: C.faint, marginTop: 3 }, weight(400)]}>{f.hint}</Text>
                      ) : null}
                    </View>
                  ),
                )}
              </View>
            )}

            {section.id === 'gst_verified' && (draft.gstin ?? '').trim() ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                <Icon name={validated ? 'shield' : 'clock'} size={13} color={validated ? C.success : C.muted} strokeWidth={2.2} />
                <Text style={[{ fontSize: 12, lineHeight: 17, color: validated ? C.success : C.muted }, weight(400)]}>
                  {validated ? 'Checked by your Sales Manager.' : 'With your Sales Manager. She checks the number when she reviews.'}
                </Text>
              </View>
            ) : section.id === 'gst_verified' ? (
              <Text style={[{ fontSize: 12, lineHeight: 17, color: C.muted, marginTop: 6 }, weight(400)]}>{section.fields[0].hint}</Text>
            ) : null}
          </View>
        );
      })}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
        <Pressable
          onPress={() => router.replace(`/lead?id=${lead.id}&from=leads`)}
          accessibilityRole="button"
          accessibilityLabel="Back to the lead"
          style={({ pressed }) => ({ minWidth: 110, maxWidth: '45%', flexShrink: 1, paddingHorizontal: 14, minHeight: 60, paddingVertical: 10, borderRadius: 30, backgroundColor: pressed ? C.wash : C.surface, alignItems: 'center', justifyContent: 'center' })}>
          <Text style={[{ fontSize: 14, lineHeight: 19, color: C.ink, textAlign: 'center' }, weight(700)]}>Back to lead</Text>
        </Pressable>
        <PrimaryButton
          label={busy ? 'Saving…' : 'Save answers'}
          tone="navy"
          onPress={save}
          disabled={busy || !writable}
          whyDisabled={writable ? undefined : 'Qualification opens once your Sales Manager has verified this Prospect.'}
          style={{ flex: 1, minHeight: 60, borderRadius: 30 }}
        />
      </View>
    </View>
  );

  return frame ? frame({ hero, body }) : (
    <>
      {hero}
      {body}
    </>
  );
}

/** Yes / No (or the three ways a price was taken) as 36 pills. A second tap
    on the picked one clears it — an answer can be taken back before Save. */
function YesNo({
  field,
  value,
  writable,
  onSet,
}: {
  field: Field;
  value: string | undefined;
  writable: boolean;
  onSet: (key: string, value: string) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {(field.kind === 'yesno' ? YES_NO : (field.options ?? [])).map((o) => {
        const on = value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => writable && onSet(field.key, on ? '' : o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, disabled: !writable }}
            accessibilityLabel={field.label + ': ' + o.label}
            hitSlop={{ top: 6, bottom: 6 }}
            style={{ minHeight: 36, paddingHorizontal: field.kind === 'yesno' ? 16 : 14, borderRadius: 18, justifyContent: 'center', backgroundColor: on ? C.navy : C.canvas }}>
            <Text style={[{ fontSize: 13, lineHeight: 18, color: on ? '#FFFFFF' : C.ink }, weight(on ? 700 : 600)]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
