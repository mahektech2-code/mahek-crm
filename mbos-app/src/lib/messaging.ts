import { Linking, Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';

/**
 * Getting a message to a customer.
 *
 * MBOS inherits the CRM's **copy-to-send** mode, and that is a decision rather
 * than a shortcut: the WhatsApp Business API is not live, so nothing here can
 * send on the company's behalf. What it does instead is prepare the message
 * exactly and hand it to the salesman's own WhatsApp, where he presses send.
 *
 * The consequence is the important part, and it runs all the way through the
 * data model: **a message is only recorded as sent when a human confirms it.**
 * Until then it is `copied` — a customer who may or may not have heard from us,
 * shown as exactly that rather than assumed either way. Marking it sent because
 * we opened WhatsApp would be a guess wearing the clothes of a fact.
 */

export type MessageChannel = 'whatsapp' | 'sms' | 'email' | 'copy';

export type SendOutcome =
  /** WhatsApp opened. Whether he pressed send is unknown and stays unknown. */
  | { status: 'handed_off'; channel: MessageChannel }
  /** No WhatsApp on the handset; the text is on the clipboard instead. */
  | { status: 'copied'; reason: string }
  | { status: 'failed'; reason: string };

/** Digits only, with the country code, as `wa.me` wants it. */
function waNumber(phone: string, dial = '91'): string {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length > 10 && digits.startsWith(dial)) return digits;
  return dial + digits.slice(-10);
}

/**
 * Open WhatsApp with the message already written.
 *
 * Falls back to the clipboard rather than failing. A salesman standing in a
 * shop with the customer waiting needs the words in his hand one way or
 * another; "WhatsApp is not installed" with nothing to show for it is the
 * worst of the three outcomes.
 */
export async function openWhatsApp(phone: string, message: string): Promise<SendOutcome> {
  const url = `whatsapp://send?phone=${waNumber(phone)}&text=${encodeURIComponent(message)}`;
  const web = `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(message)}`;

  try {
    if (await Linking.canOpenURL(url)) {
      await Linking.openURL(url);
      return { status: 'handed_off', channel: 'whatsapp' };
    }
    await Linking.openURL(web);
    return { status: 'handed_off', channel: 'whatsapp' };
  } catch {
    await Clipboard.setStringAsync(message);
    return { status: 'copied', reason: 'WhatsApp would not open. The message is copied — paste it there.' };
  }
}

export async function openSms(phone: string, message: string): Promise<SendOutcome> {
  /* iOS wants `&` for the body, Android wants `?`. Getting it wrong opens the
     composer with an empty message, which reads as the app losing the text. */
  const sep = Platform.OS === 'ios' ? '&' : '?';
  const url = `sms:${phone.replace(/[^0-9+]/g, '')}${sep}body=${encodeURIComponent(message)}`;
  try {
    await Linking.openURL(url);
    return { status: 'handed_off', channel: 'sms' };
  } catch {
    await Clipboard.setStringAsync(message);
    return { status: 'copied', reason: 'The messaging app would not open. The message is copied.' };
  }
}

export async function copyToClipboard(message: string): Promise<SendOutcome> {
  await Clipboard.setStringAsync(message);
  return { status: 'copied', reason: 'Copied. Paste it wherever you need it.' };
}

/** The system share sheet, for anything that is not a specific channel. */
export async function shareText(message: string, title?: string): Promise<SendOutcome> {
  try {
    await Share.share({ message, title });
    return { status: 'handed_off', channel: 'copy' };
  } catch {
    return { status: 'failed', reason: 'Nothing could open to share that.' };
  }
}

export async function callNumber(phone: string): Promise<SendOutcome> {
  try {
    await Linking.openURL(`tel:${phone.replace(/[^0-9+]/g, '')}`);
    return { status: 'handed_off', channel: 'sms' };
  } catch {
    return { status: 'failed', reason: 'The phone app would not open.' };
  }
}

/* --------------------------------------------------------------- the map */

export type Place = { lat: number; lng: number; label?: string | null };

/**
 * Hand a shop to whatever maps app is on the handset.
 *
 * The Navigate button on the route screen toasted the customer's NAME and did
 * nothing else — on the one card the design says has to be readable while
 * walking. It read as a maps app that had failed to open.
 *
 * `geo:` is the Android intent and takes every navigation app installed, which
 * is the right first ask: a salesman uses whichever one he has. The Google
 * Maps URL is the fallback and works on iOS and in a browser. The LABEL rides
 * along where there is one, because "Karnataka Hardware" on the pin is what
 * confirms he is walking to the right place; the coordinate alone is
 * unreadable.
 */
export async function openMaps(place: Place): Promise<SendOutcome> {
  const at = `${place.lat},${place.lng}`;
  const label = place.label?.trim();
  const geo = label ? `geo:${at}?q=${at}(${encodeURIComponent(label)})` : `geo:${at}?q=${at}`;
  const web = `https://www.google.com/maps/search/?api=1&query=${at}`;

  try {
    if (await Linking.canOpenURL(geo)) {
      await Linking.openURL(geo);
      return { status: 'handed_off', channel: 'copy' };
    }
    await Linking.openURL(web);
    return { status: 'handed_off', channel: 'copy' };
  } catch {
    return { status: 'failed', reason: 'No maps app on this phone would open.' };
  }
}

/**
 * How many stops one maps URL will carry.
 *
 * Google's directions URL takes a destination and waypoints before it, and
 * stops honouring the list past about nine. A day is routinely longer than
 * that, so the URL is built from the first nine and the screen SAYS so — a
 * route silently truncated is worse than one that names its own limit,
 * because the tenth shop is simply not walked.
 */
export const MAPS_WAYPOINT_LIMIT = 9;

/**
 * The whole day, in order, as one set of directions.
 *
 * Only a stop with a coordinate can go in, and the number that could not is
 * returned rather than swallowed — the same answer `optimiseRoute` already
 * gives about the same shops. Nothing here reorders anything: the order handed
 * in is the order he means to walk, and a maps app rearranging it would
 * quietly undo the reordering the route screen just did.
 */
export async function openRoute(
  /* Nullable coordinates deliberately: a stop with no location is part of the
     day and part of the count that could not be sent, and casting it to a
     number to satisfy this signature would put NaN in a URL. */
  places: { lat: number | null; lng: number | null; label?: string | null }[],
): Promise<SendOutcome & { sent?: number; dropped?: number }> {
  const usable = places.filter((p): p is Place =>
    typeof p.lat === 'number' && typeof p.lng === 'number' &&
    Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!usable.length) {
    return { status: 'failed', reason: 'None of today’s stops has a location recorded.' };
  }

  const taken = usable.slice(0, MAPS_WAYPOINT_LIMIT + 1);
  const at = (p: Place) => `${p.lat},${p.lng}`;
  const destination = taken[taken.length - 1]!;
  const between = taken.slice(0, -1);

  const url =
    'https://www.google.com/maps/dir/?api=1' +
    `&destination=${at(destination)}` +
    (between.length ? `&waypoints=${between.map(at).join('|')}` : '') +
    '&travelmode=driving';

  try {
    await Linking.openURL(url);
    return {
      status: 'handed_off',
      channel: 'copy',
      sent: taken.length,
      dropped: places.length - taken.length,
    };
  } catch {
    return { status: 'failed', reason: 'No maps app on this phone would open.' };
  }
}

/* ------------------------------------------------------------- the words */

/**
 * A receipt, written out.
 *
 * Generated on the handset so it can be shown and sent with no signal at all —
 * the customer has just handed over money and wants something for it now, not
 * when the phone next finds a tower.
 *
 * The reference is marked provisional where the server has not yet issued the
 * real number. Printing a temporary reference as though it were the receipt
 * number is how two different numbers end up on one payment.
 */
export function receiptMessage(args: {
  businessName?: string;
  customerName: string;
  amountRupees: string;
  mode: string;
  reference: string;
  confirmed: boolean;
  collectedBy: string;
  when: string;
  chequeNumber?: string | null;
}): string {
  const lines = [
    `${args.businessName ?? 'Mahek Marketing'} — receipt`,
    '',
    `Received from: ${args.customerName}`,
    `Amount: ${args.amountRupees}`,
    `Mode: ${args.mode}${args.chequeNumber ? ` (cheque ${args.chequeNumber})` : ''}`,
    `Date: ${args.when}`,
    `Collected by: ${args.collectedBy}`,
    '',
    args.confirmed
      ? `Receipt no: ${args.reference}`
      : `Reference: ${args.reference} — the office will confirm the receipt number.`,
  ];

  if (!args.confirmed) {
    /* Said plainly, because a cheque can bounce and cash can fail to arrive.
       A receipt that implies the business has the money when it has not seen
       it yet is the one sentence on this slip that could be untrue. */
    lines.push('', 'This is your salesman’s record of the payment, not a bank confirmation.');
  }

  return lines.join('\n');
}

/** An order, written out, for a customer who wants it in writing. */
export function orderMessage(args: {
  customerName: string;
  reference: string;
  confirmed: boolean;
  lines: { name: string; cans: number }[];
  valueRupees: string | null;
  when: string;
}): string {
  const out = [
    `Order — ${args.customerName}`,
    `Date: ${args.when}`,
    args.confirmed ? `Order no: ${args.reference}` : `Reference: ${args.reference} — number to follow.`,
    '',
    ...args.lines.map((l) => `${l.name} — ${l.cans} ${l.cans === 1 ? 'can' : 'cans'}`),
  ];

  /* No value where the price source is unset. A total of ₹0 on a message the
     customer keeps is worse than no total at all. */
  if (args.valueRupees) out.push('', `Value: ${args.valueRupees}`);

  return out.join('\n');
}
