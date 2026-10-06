import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Card, Choice, Divider, Input, PrimaryButton, SecondaryButton, T } from '../ui/primitives';
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
  const credit = (draft.creditDaysWanted ?? '').replace(/[^\d]/g, '');
  return {
    ...base,
    gstin: 'gstin' in draft ? draft.gstin : base.gstin,
    application: 'application' in draft ? draft.application : base.application,
    decisionMaker: 'decisionMaker' in draft ? draft.decisionMaker : base.decisionMaker,
    creditDaysWanted: 'creditDaysWanted' in draft ? (credit ? Number(credit) : null) : base.creditDaysWanted,
    qualification,
  };
}

/** Which of the eight are still open, asked of the engine. The GST row is "answered" once the number is there: validating it is the Sales Manager's. */
function openRows(input: LeadGateInput): Set<string> {
  const missing = new Set(gateTo(input, 'sample_trial').missing.map((c) => c.id));
  if ((input.gstin ?? '').trim()) missing.delete('gst_verified');
  return missing;
}

export function QualificationForm({ view, onSaved }: { view: LeadFunnelView; onSaved: () => void }) {
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
        const digits = text('creditDaysWanted').replace(/[^\d]/g, '');
        prospect.creditDaysWanted = digits ? Math.min(365, Number(digits)) : null;
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

  return (
    <>
      <Card>
        <T style={[{ fontSize: 17, lineHeight: 23, color: C.ink }, weight(600)]}>{lead.company?.trim() || lead.name}</T>
        <Divider style={{ marginVertical: 12 }} />
        <T style={[{ fontSize: 20, lineHeight: 26, color: C.ink }, weight(600)]}>{done + ' of ' + total + ' answered'}</T>
        <T s="caption" style={{ marginTop: 2 }}>
          {done === total
            ? 'All saved. Your Sales Manager validates the GST number and reviews the rest.'
            : plural(total - done, 'question') + ' left. Only saved answers count. Press Save to keep them all.'}
        </T>
      </Card>

      {!writable ? (
        <Card style={{ marginTop: 16 }}>
          <T style={{ fontSize: 14, lineHeight: 20, color: C.muted }}>
            Qualification opens once your Sales Manager has verified this Prospect. Until then there is nothing to answer here.
          </T>
        </Card>
      ) : null}

      <View style={{ marginTop: 16, gap: 12 }}>
        {SECTIONS.map((section, i) => {
          const open = live.has(section.id);
          return (
            <Card key={section.id}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(500)]}>
                    {i + 1}. {section.title}
                  </T>
                  {section.id === 'gst_verified' && (draft.gstin ?? '').trim() ? (
                    <T s="caption" style={{ marginTop: 2 }}>
                      {validated ? 'Checked by your Sales Manager.' : 'With your Sales Manager. She checks the number when she reviews.'}
                    </T>
                  ) : null}
                </View>
                <T style={[{ fontSize: 14, color: open ? C.muted : C.success }, weight(600)]}>{open ? 'Not yet' : 'Done'}</T>
              </View>

              {section.fields.map((f) => (
                <View key={f.key} style={{ marginTop: 12 }}>
                  <T s="caption">{f.label}</T>
                  {f.kind === 'yesno' || f.kind === 'choice' ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      {(f.kind === 'yesno' ? YES_NO : (f.options ?? [])).map((o) => (
                        <Choice
                          key={o.value}
                          label={o.label}
                          selected={draft[f.key] === o.value}
                          onPress={() => writable && set(f.key, draft[f.key] === o.value ? '' : o.value)}
                          style={{ paddingHorizontal: 14, minHeight: 40 }}
                        />
                      ))}
                    </View>
                  ) : (
                    <Input
                      value={draft[f.key] ?? ''}
                      editable={writable}
                      onChangeText={(v) => set(f.key, v)}
                      placeholder={f.kind === 'date' ? 'YYYY-MM-DD' : ''}
                      keyboardType={f.kind === 'int' ? 'number-pad' : 'default'}
                      multiline={f.kind === 'long'}
                      style={{ marginTop: 6 }}
                    />
                  )}
                  {f.hint ? <T s="caption" style={{ marginTop: 4 }}>{f.hint}</T> : null}
                </View>
              ))}
            </Card>
          );
        })}
      </View>

      <PrimaryButton
        label={busy ? 'Saving…' : 'Save answers'}
        onPress={save}
        disabled={busy || !writable}
        whyDisabled={writable ? undefined : 'Qualification opens once your Sales Manager has verified this Prospect.'}
        style={{ marginTop: 18 }}
      />
      <SecondaryButton
        label="Back to the lead"
        onPress={() => router.replace(`/lead?id=${lead.id}&from=leads`)}
        style={{ marginTop: 10 }}
      />
    </>
  );
}
