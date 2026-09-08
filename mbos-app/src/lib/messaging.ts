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

/**
 * Take him there.
 *
 * This button existed and did nothing — it raised a toast saying "Maps to
 * <shop>" and stopped, which is worse than not drawing it: a control that
 * acknowledges the tap and then does not act teaches people the app is
 * unreliable rather than that the feature is missing.
 *
 * The coordinates are the point. Most of this book is pinned, and a shop in a
 * market lane is findable by its dot and very often not by its name — so where
 * there is a fix, that is what is handed over, and the shop's name rides along
 * only as the LABEL on the pin. Where there is no fix we search for the name
 * and the town instead, which is the same thing he would have typed himself.
 *
 * `google.navigation:` first, because it starts turn-by-turn in the app he
 * already has, and the https form second, which any Android resolves into
 * Google Maps and any other platform opens in a browser. Falling all the way
 * to the browser is still an answer; refusing is not.
 */
export type MapsOutcome = { status: 'opened' } | { status: 'failed'; reason: string };

export async function openMaps(args: {
  lat?: number | null;
  lng?: number | null;
  name?: string | null;
  city?: string | null;
}): Promise<MapsOutcome> {
  const hasFix = typeof args.lat === 'number' && typeof args.lng === 'number';

  const query = hasFix
    ? `${args.lat},${args.lng}`
    : [args.name, args.city].filter(Boolean).join(' ').trim();

  if (!query) {
    return {
      status: 'failed',
      reason: 'No location and no name to search for on this customer.',
    };
  }

  /* Turn-by-turn straight away, which is what the button says it does. */
  const native = hasFix
    ? `google.navigation:q=${args.lat},${args.lng}`
    : `geo:0,0?q=${encodeURIComponent(query)}`;
  const web = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;

  try {
    if (Platform.OS === 'android' && (await Linking.canOpenURL(native))) {
      await Linking.openURL(native);
      return { status: 'opened' };
    }
    await Linking.openURL(web);
    return { status: 'opened' };
  } catch {
    return { status: 'failed', reason: 'No maps app would open on this handset.' };
  }
}

/**
 * THE WHOLE DAY, IN ORDER.
 *
 * "Navigate the whole day" raised the words "Full route sent to maps" and sent
 * nothing. That is the worse half of this class of bug: a control that does
 * nothing teaches you it is broken, and a control that SAYS IT DID teaches you
 * to believe it — so the salesman sets off expecting his phone to know where he
 * is going.
 *
 * Google's directions URL takes a destination and waypoints in between, and it
 * caps the waypoints at NINE. A beat can be longer than that, so the extra
 * stops are dropped from the ROUTE and the caller is told how many, rather than
 * the whole thing silently failing or — worse — opening a route that quietly
 * misses the afternoon.
 *
 * Stops with no coordinates are dropped for the same reason a shop with no pin
 * cannot be navigated to individually: there is nothing to send.
 */
const MAX_WAYPOINTS = 9;

export type RouteOutcome =
  | { status: 'opened'; used: number; dropped: number }
  | { status: 'failed'; reason: string };

export async function openRoute(
  stops: { lat?: number | null; lng?: number | null }[],
): Promise<RouteOutcome> {
  const pinned = stops
    .filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
    .map((s) => `${s.lat},${s.lng}`);

  if (pinned.length === 0) {
    return {
      status: 'failed',
      reason: 'None of today’s stops has a location saved, so there is no route to open.',
    };
  }
  if (pinned.length === 1) {
    const out = await openMaps({ lat: stops[0].lat, lng: stops[0].lng });
    return out.status === 'opened'
      ? { status: 'opened', used: 1, dropped: 0 }
      : { status: 'failed', reason: out.reason };
  }

  /* The last one is the destination; everything before it is a waypoint, and
     only the first nine of those fit. */
  const destination = pinned[pinned.length - 1];
  const middle = pinned.slice(0, -1);
  const used = middle.slice(0, MAX_WAYPOINTS);
  const dropped = middle.length - used.length;

  const url =
    'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
    `&destination=${encodeURIComponent(destination)}` +
    (used.length ? `&waypoints=${encodeURIComponent(used.join('|'))}` : '');

  try {
    await Linking.openURL(url);
    return { status: 'opened', used: used.length + 1, dropped };
  } catch {
    return { status: 'failed', reason: 'No maps app would open on this handset.' };
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

/**
 * The system share sheet, for anything that is not a specific channel.
 *
 * It is what "Share the plan" uses. That control said "To your manager on
 * WhatsApp" and then reported "Route shared", and neither was true — nor could
 * the first have been: nothing on this handset knows which number his manager
 * is on. The share sheet does, because his recent chats are in it, so it asks
 * rather than guessing.
 */
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
