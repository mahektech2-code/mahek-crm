import {
  BrandPanel,
  BrandPanelHeading,
} from "@/components/shell/brand-panel";
import { AppChooser, type Team } from "./app-chooser";

export const metadata = { title: "Download the apps - MahekOne" };

const TEAMS: Team[] = ["sales", "erp"];

/**
 * `?team=sales` (or erp) opens with that team already chosen, so a
 * link sent to one team lands on their app without the question.
 */
export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const { team } = await searchParams;
  const initialTeam = TEAMS.find((t) => t === team) ?? null;

  return (
    <div className="grid min-h-screen grid-cols-1 bg-canvas md:grid-cols-2">
      <BrandPanel>
        <BrandPanelHeading eyebrow="MahekOne apps">
          The right app for your work, on your phone
        </BrandPanelHeading>
        <p className="animate-rise mt-4 text-sm leading-6 text-white/75 [animation-delay:80ms]">
          MBOS for the field sales team, Mahek Factory for the floor. Pick your
          team and get the one that is yours.
        </p>
      </BrandPanel>

      <div className="flex min-w-0 justify-center px-4 py-8 md:items-center md:p-10">
        <div className="flex w-full max-w-[440px] flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-1.5 md:hidden">
            <span className="relative h-6 w-6 flex-none">
              <span className="absolute inset-0 flex items-center justify-center rounded-[4px] bg-brand">
                <span className="block h-2.5 w-2.5 rounded-[2px] bg-white" />
              </span>
            </span>
            <span className="text-base font-semibold tracking-[-0.01em] text-ink">
              MAHEK<span className="text-brand">ONE</span>
            </span>
          </div>

          <div className="w-full text-center md:text-left">
            <h1 className="text-xl font-semibold text-ink">
              Download the apps
            </h1>
            <p className="mt-1.5 text-sm text-muted">
              Choose your team to see the app that is for you.
            </p>
          </div>

          <AppChooser initialTeam={initialTeam} />
        </div>
      </div>
    </div>
  );
}
