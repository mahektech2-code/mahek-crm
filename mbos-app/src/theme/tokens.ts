/**
 * Every value here is lifted verbatim from `MBOS Field Sales.dc.html`.
 * The design is the source of truth for anything visual, so a colour or a
 * radius that is not in that file does not belong in this one either — a
 * screen needing a shade nobody chose is a screen drifting away from the
 * design, and the drift is invisible until the two are put side by side.
 */

export const color = {
  /* brand */
  primary: '#6835FB',
  primaryDeep: '#4419C4',
  primaryDark: '#3D14A8',
  primaryTint: '#F1ECFF',
  primaryEdge: '#DCD1FC',
  lime: '#C6FF34',

  /* VERSION 3 — the MahekOne v4 language the ERP and Tele CRM already wear,
     carried to the handset. Navy is the hero block on the day screens and the
     floating tab bar; lavender is the hero block everywhere else. */
  navy: '#0F1B33',
  navySoft: 'rgba(255,255,255,0.08)',
  onNavy: '#FFFFFF',
  onNavyMuted: '#9AA5BA',
  limeOnNavy: 'rgba(198,255,52,0.14)',
  lavender: '#EFEAFD',
  lavenderInk: '#1E1446',
  lavenderMuted: '#5A4E8C',
  line: '#D3DBE7',

  /* ink */
  ink: '#0F1B33',
  body: '#33415C',
  muted: '#5E6B85',
  faint: '#9AA5BA',

  /* structure */
  border: '#DCE3EE',
  hairline: '#E8EDF4',
  wash: '#EDF1F7',
  surface: '#FFFFFF',
  canvas: '#EDF1F7',
  /** A read notification. Barely off white on purpose — unread has to win. */
  surfaceRead: '#FCFCFD',

  /* status */
  success: '#1D7A45',
  successBg: '#E7F4EC',
  warn: '#D9930D',
  warnInk: '#8A5C05',
  warnBg: '#FDF3DC',
  warnEdge: '#F3DFA8',
  danger: '#B3261E',
  dangerBg: '#FCEBEA',
  info: '#2B5CBF',
  infoBg: '#EDF2FC',

  /* scrims */
  /* Behind every bottom sheet, the + menu's included. Light enough that the
     screen he was on stays readable behind the sheet — at 0.52 it went nearly
     black and the sheet read as a different screen rather than as something
     opened over this one. A real blur needs a native module (expo-blur), so it
     waits for an APK rather than riding an over-the-air update. */
  scrim: 'rgba(16,18,24,0.28)',
  scrimLight: 'rgba(22,22,22,0.45)',
} as const;

/**
 * The design leans on three shadows and no more. `boxShadow` is a real style
 * prop from React Native 0.76 onward, so these are the CSS strings unchanged
 * rather than an elevation number that would land differently on each platform.
 */
export const shadow = {
  card: '0 1px 2px rgba(22,22,22,0.04), 0 8px 24px -12px rgba(22,22,22,0.10)',
  soft: '0 1px 3px rgba(22,22,22,0.05)',
  primary: '0 2px 12px rgba(104,53,251,0.3)',
  primaryLift: '0 6px 16px -6px rgba(104,53,251,0.45)',
  primaryDeep: '0 8px 24px -8px rgba(104,53,251,0.55)',
  fab: '0 4px 14px rgba(104,53,251,0.34)',
  tabBar: '0 -8px 24px -16px rgba(22,22,22,0.18)',
  saveBar: '0 -4px 24px rgba(22,22,22,0.08)',
  sheet: '0 -4px 24px rgba(22,22,22,0.16)',
  toast: '0 8px 24px -6px rgba(61,20,168,0.55)',
  dialog: '0 12px 32px rgba(22,22,22,0.24)',
  nextStop: '0 1px 2px rgba(22,22,22,0.04), 0 10px 28px -14px rgba(104,53,251,0.35)',
} as const;

export const font = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
  extrabold: 'Geist_800ExtraBold',
} as const;

/**
 * React Native has no `font-weight` that reaches a variable font reliably on
 * Android — the weight has to be in the family name. `weight()` is the one
 * place that translation happens, so a screen writes the weight it means and
 * never has to remember which file carries it.
 */
export function weight(w: 400 | 500 | 600 | 700 | 800): { fontFamily: string } {
  return {
    fontFamily:
      w === 800 ? font.extrabold : w === 700 ? font.bold : w === 600 ? font.semibold : w === 500 ? font.medium : font.regular,
  };
}

/** Figures line up in columns only if they are tabular. The design sets this globally. */
export const tabular = { fontVariant: ['tabular-nums' as const, 'lining-nums' as const] };

export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  card: 20,
  sheet: 24,
  sheetTall: 28,
  /** The hero block's bottom corners and the floating bar. */
  hero: 28,
  pill: 24,
  phone: 20,
} as const;

/** The minimum touch target the design holds to everywhere. */
export const HIT = 48;

export const type = {
  /* screen titles */
  display: { fontSize: 28, lineHeight: 34, ...weight(800), letterSpacing: -0.56, color: color.ink },
  h1: { fontSize: 22, lineHeight: 28, ...weight(800), letterSpacing: -0.44, color: color.ink },
  h2: { fontSize: 19, lineHeight: 25, ...weight(700), letterSpacing: -0.38, color: color.ink },
  h3: { fontSize: 17, lineHeight: 23, ...weight(700), color: color.ink },
  /* body */
  body: { fontSize: 15, lineHeight: 22, ...weight(400), color: color.body },
  bodyInk: { fontSize: 15, lineHeight: 22, ...weight(400), color: color.ink },
  small: { fontSize: 14, lineHeight: 20, ...weight(400), color: color.body },
  caption: { fontSize: 13, lineHeight: 19, ...weight(400), color: color.muted },
  micro: { fontSize: 12, lineHeight: 16, ...weight(400), color: color.muted },
  /* The section label above almost every card. Version 3 writes it in
     sentence case, as the ERP and Tele CRM do — capitals shout on a phone. */
  label: {
    fontSize: 13,
    lineHeight: 18,
    ...weight(700),
    letterSpacing: 0,
    color: color.muted,
  },
} as const;

export type BadgeTone = 'teal' | 'info' | 'success' | 'danger' | 'amber' | 'neutral';

/** The badge palette, exactly as `badge()` defines it in the design. */
export const BADGE: Record<BadgeTone, { bg: string; fg: string }> = {
  teal: { bg: color.primaryTint, fg: color.primaryDeep },
  info: { bg: color.infoBg, fg: color.info },
  success: { bg: color.successBg, fg: color.success },
  danger: { bg: color.dangerBg, fg: color.danger },
  amber: { bg: color.warnBg, fg: color.warnInk },
  neutral: { bg: color.hairline, fg: color.muted },
};
