import type { AreaRule } from './lead-areas';
import { matchLocation, type LocationMatch } from './lead-scan';

/**
 * WHAT A SPOKEN DESCRIPTION PUTS IN THE NEW LEAD FORM — pure, so it is tested
 * here rather than on a phone.
 *
 * The office reads what he said (`/api/mbos/lead-voice`) and sends back what
 * it heard; this decides which of those answers can land on THIS form. The
 * office already refused codes that are not on its lists, and the check is
 * repeated here against the lists this phone draws — the two are the same
 * configuration, but a phone that has not pulled since a manager edited
 * `leads.sources` holds the older list, and a chip that is not drawn cannot be
 * the selected one.
 */

/** What `/api/mbos/lead-voice` answers — `engines/lead-voice.ts` on the server. */
export type LeadVoiceFound = {
  salesType: string | null;
  businessName: string | null;
  contactPerson: string | null;
  mobile: string | null;
  otherNumbers: string[];
  gstin: string | null;
  gstinCheck: 'valid' | 'corrected' | 'invalid' | null;
  city: string | null;
  state: string | null;
  address: string | null;
  source: string | null;
  sourceDetail: string | null;
  potentialRupees: number | null;
  followUp: {
    date: string | null;
    explanation: string | null;
    choices: { date: string; label: string }[];
  } | null;
  customerType: string | null;
  requirement: string | null;
  monthlyLitres: number | null;
  decisionMaker: string | null;
  competitor: string | null;
  questions: string[];
};

/** Every answer the voice can give, in the order the form asks them. */
export type LeadVoiceField =
  | 'salesType'
  | 'name'
  | 'company'
  | 'mobile'
  | 'gstin'
  | 'location'
  | 'source'
  | 'potential'
  | 'followUp'
  | 'address'
  | 'custType'
  | 'requirement'
  | 'litres'
  | 'decisionMaker'
  | 'competitor';

export const VOICE_FIELDS: LeadVoiceField[] = [
  'salesType',
  'name',
  'company',
  'mobile',
  'gstin',
  'location',
  'source',
  'potential',
  'followUp',
  'address',
  'custType',
  'requirement',
  'litres',
  'decisionMaker',
  'competitor',
];

/** The form's own words for each answer, so the review reads like the form. */
export const VOICE_FIELD_LABEL: Record<LeadVoiceField, string> = {
  salesType: 'Kind of sale',
  name: 'Who you spoke to',
  company: 'Shop name',
  mobile: 'Mobile',
  gstin: 'GST number',
  location: 'Town',
  source: 'How you found them',
  potential: 'Can buy a month (₹)',
  followUp: 'Next follow-up',
  address: 'Where the shop is',
  custType: 'Kind of business',
  requirement: 'What they want',
  litres: 'Litres a month',
  decisionMaker: 'Who decides',
  competitor: 'Who they buy from now',
};

/** A choice the review shows as words and fills as a code. */
export const CHOICE_FIELDS = new Set<LeadVoiceField>(['salesType', 'source', 'custType', 'followUp']);

type Option = { code: string; label: string };

export type VoiceLists = {
  salesTypes: Option[];
  sources: Option[];
  customerTypes: Option[];
};

/** The value each field starts the review with — text for a box, a code for a choice. */
export function voiceValues(found: LeadVoiceFound, lists: VoiceLists): Record<LeadVoiceField, string> {
  const onList = (code: string | null, list: Option[]) => (code && list.some((o) => o.code === code) ? code : '');
  return {
    salesType: onList(found.salesType, lists.salesTypes),
    name: found.contactPerson ?? '',
    company: found.businessName ?? '',
    mobile: found.mobile ?? '',
    gstin: found.gstin ?? '',
    location: found.city ?? '',
    source: onList(found.source, lists.sources),
    potential: found.potentialRupees ? String(found.potentialRupees) : '',
    followUp: found.followUp?.date ?? '',
    address: found.address ?? '',
    custType: onList(found.customerType, lists.customerTypes),
    requirement: found.requirement ?? '',
    litres: found.monthlyLitres ? String(found.monthlyLitres) : '',
    decisionMaker: found.decisionMaker ?? '',
    competitor: found.competitor ?? '',
  };
}

/** The words a choice field shows — the label for a code. */
export function choiceWord(field: LeadVoiceField, code: string, lists: VoiceLists): string {
  const list = field === 'salesType' ? lists.salesTypes : field === 'source' ? lists.sources : lists.customerTypes;
  return list.find((o) => o.code === code)?.label ?? code;
}

/** What "Fill the form" hands the form — only ticked, non-empty values. */
export type LeadVoiceFill = {
  salesType?: string;
  name?: string;
  company?: string;
  mobile?: string;
  gstin?: string;
  location?: LocationMatch;
  source?: string;
  sourceDetail?: string;
  potential?: string;
  followUp?: string;
  address?: string;
  custType?: string;
  requirement?: string;
  litres?: string;
  decisionMaker?: string;
  competitor?: string;
};

/* "98220 11001", "+91 98220 11001" and "098220 11001" are one mobile. */
function mobileDigits(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

export function voiceFill(args: {
  values: Record<LeadVoiceField, string>;
  ticked: Record<LeadVoiceField, boolean>;
  found: LeadVoiceFound;
  areas: AreaRule;
}): LeadVoiceFill {
  const { values, ticked, found, areas } = args;
  const val = (f: LeadVoiceField) => (ticked[f] ? values[f].trim() : '');
  const out: LeadVoiceFill = {};
  if (val('salesType')) out.salesType = val('salesType');
  if (val('name')) out.name = val('name');
  if (val('company')) out.company = val('company');
  if (val('mobile')) out.mobile = mobileDigits(val('mobile'));
  if (val('gstin')) out.gstin = val('gstin').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (val('location')) {
    const m = matchLocation(areas, val('location'), found.state);
    if (m) out.location = m;
  }
  if (val('source')) {
    out.source = val('source');
    if (found.sourceDetail) out.sourceDetail = found.sourceDetail;
  }
  /* Whole numbers only — the boxes they land in are number pads. */
  if (val('potential').replace(/\D/g, '')) out.potential = val('potential').replace(/\D/g, '');
  if (val('followUp')) out.followUp = val('followUp');
  if (val('address')) out.address = val('address');
  if (val('custType')) out.custType = val('custType');
  if (val('requirement')) out.requirement = val('requirement');
  if (val('litres').replace(/\D/g, '')) out.litres = val('litres').replace(/\D/g, '');
  if (val('decisionMaker')) out.decisionMaker = val('decisionMaker');
  if (val('competitor')) out.competitor = val('competitor');
  return out;
}
