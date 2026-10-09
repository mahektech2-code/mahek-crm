import { Callout } from "@/components/ui/primitives";
import { PROTOTYPE_NOTE } from "./prototype";

/**
 * The banner above every Website screen. Drawn once, by the app's layout, so
 * no screen can forget it and no two of them word it differently.
 */
export function PrototypeNotice() {
  return (
    <div className="px-6 pt-5">
      <Callout tone="warn" className="mb-0">
        <span role="note" data-testid="prototype-notice" className="text-sm text-body">
          <strong className="font-semibold text-ink">Prototype.</strong> {PROTOTYPE_NOTE} Nothing here is saved to a
          database or published to the live website.
        </span>
      </Callout>
    </div>
  );
}
