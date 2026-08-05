/**
 * The deep-purple half of the signed-out screens.
 *
 * It is decoration and nothing else — no control lives in here — so the whole
 * ornament layer is `aria-hidden` and every animation on it is switched off by
 * the reduced-motion rule in globals.css.
 */
export function BrandPanel({
  children,
  footer,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="relative hidden min-w-0 flex-col justify-between overflow-hidden bg-brand-deep p-12 shadow-[inset_-1px_0_0_rgba(255,255,255,0.10)] md:flex">
      <Ornaments />

      <div className="relative flex items-center gap-2.5">
        <span className="animate-mark-pop relative h-5.5 w-5.5 flex-none">
          <span className="absolute inset-0 flex items-center justify-center rounded-[4px] bg-brand-lime">
            <span className="block h-2 w-2 rounded-[2px] bg-brand-deep" />
          </span>
          <span className="animate-pulse-ring pointer-events-none absolute inset-0 rounded-[4px] border-2 border-brand-lime" />
        </span>
        <span className="text-lg font-semibold tracking-[-0.01em] text-white">
          MAHEK<span className="text-brand-lime">ONE</span>
        </span>
      </div>

      <div className="relative max-w-[440px]">{children}</div>

      <div className="relative">{footer}</div>
    </div>
  );
}

/** Headline treatment shared by the sign-in and reset panels. */
export function BrandPanelHeading({
  eyebrow,
  children,
}: {
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="animate-rise text-[11px] font-medium tracking-[0.04em] text-brand-lime uppercase">
        {eyebrow}
      </div>
      <h2 className="animate-rise mt-3.5 text-[32px] leading-[42px] font-semibold text-balance text-white [animation-delay:40ms]">
        {children}
      </h2>
    </>
  );
}

/** The lime underline the sign-in headline draws under "one sign-in". */
export function BrandUnderline({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative whitespace-nowrap">
      {children}
      <span
        aria-hidden
        className="animate-underline-in absolute right-0 bottom-0.5 left-0 h-[3px] origin-left rounded-[2px] bg-brand-lime"
      />
    </span>
  );
}

function Ornaments() {
  return (
    <span aria-hidden className="pointer-events-none">
      <span className="animate-sweep absolute top-0 right-0 h-30 w-px bg-linear-to-b from-transparent via-brand-lime to-transparent" />
      <span className="animate-beam absolute top-0 left-0 h-45 w-[70%] bg-linear-[105deg,transparent_0%,rgba(198,255,52,0.14)_45%,transparent_100%]" />
      <span className="animate-drift absolute -right-[90px] -bottom-[90px] h-80 w-80 rounded-full bg-brand-hover" />
      <span className="animate-drift absolute -top-30 -right-35 h-105 w-105 rounded-full border border-white/10 [animation-duration:18s]" />
      <span className="animate-drift absolute -top-10 -right-15 h-65 w-65 rounded-full border border-white/8 [animation-direction:reverse] [animation-duration:22s]" />
      <span className="animate-drift absolute -bottom-40 -left-30 h-95 w-95 rounded-full border border-white/8 [animation-duration:26s]" />

      <span className="animate-orbit absolute -top-30 -right-35 h-105 w-105">
        <span className="absolute -top-1 left-1/2 -ml-1 block h-2 w-2 rounded-full bg-brand-lime shadow-[0_0_12px_rgba(198,255,52,0.8)]" />
      </span>
      <span className="animate-orbit absolute -bottom-40 -left-30 h-95 w-95 [animation-direction:reverse] [animation-duration:20s]">
        <span className="absolute -top-[3px] left-1/2 -ml-[3px] block h-1.5 w-1.5 rounded-full bg-white/70" />
      </span>
    </span>
  );
}
