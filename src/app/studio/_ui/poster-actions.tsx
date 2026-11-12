"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { recordShare, removePoster } from "@/lib/actions/studio";

/* ---------------------------------------------------------------------------
 * GETTING A POSTER OUT OF THE STUDIO, which is the whole point of it.
 *
 * Download saves the file. On a phone, Share hands the picture and the
 * message to the phone's own share sheet — WhatsApp included — which is the
 * only way a web page can put an image INTO a chat. On a desktop there is no
 * such sheet, so "Open WhatsApp" opens the chat with the message written and
 * the person attaches the file they just downloaded; the button says so.
 *
 * Nothing is sent by MahekOne. Every way out is recorded, so the poster's
 * page can say who sent it and when.
 * ------------------------------------------------------------------------- */

export function PosterActions(props: {
  posterId: string;
  imageUrl: string;
  fileName: string;
  caption: string | null;
  whatsappHref: string | null;
  whatsappBlocked: string | null;
  canRemove: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [caption, setCaption] = useState(props.caption ?? "");
  const [busy, setBusy] = useState(false);
  /* Whether the phone has a share sheet is a fact about the browser, not the
     server: read it after hydration so the two first renders agree. */
  const canShareFiles = useSyncExternalStore(
    () => () => {},
    () => "canShare" in navigator,
    () => false,
  );

  const download = async (format: "png" | "jpeg") => {
    void recordShare(props.posterId, "download", format);
    const a = document.createElement("a");
    a.href = `${props.imageUrl}?format=${format}&download=1`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const share = async () => {
    setBusy(true);
    try {
      const blob = await (await fetch(`${props.imageUrl}?format=jpeg`)).blob();
      const file = new File([blob], props.fileName.replace(/\.png$/, ".jpg"), { type: "image/jpeg" });
      if (!navigator.canShare?.({ files: [file] })) {
        toast.push("This browser cannot share a picture. Download it and attach it instead.", "error");
        return;
      }
      await navigator.share({ files: [file], text: caption || undefined });
      await recordShare(props.posterId, "device", "jpeg");
      router.refresh();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) toast.push("Sharing did not finish. Try again, or download it.", "error");
    } finally {
      setBusy(false);
    }
  };

  const openWhatsapp = async () => {
    if (!props.whatsappHref) return;
    await recordShare(props.posterId, "whatsapp");
    const href = caption ? props.whatsappHref.replace(/\?text=.*$/, `?text=${encodeURIComponent(caption)}`) : props.whatsappHref.replace(/\?text=.*$/, "");
    window.open(href, "_blank", "noopener");
    router.refresh();
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="text-sm font-semibold text-ink">Send it</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => download("png")}>
          Download PNG
        </Button>
        <Button onClick={() => download("jpeg")}>Download JPG</Button>
        {canShareFiles ? (
          <Button onClick={share} disabled={busy}>
            {busy ? "Preparing…" : "Share…"}
          </Button>
        ) : null}
      </div>
      {props.caption !== null ? (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Message to send with it</span>
          <Textarea rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} />
        </label>
      ) : null}
      {props.whatsappHref ? (
        <div>
          <Button variant="whatsapp" onClick={openWhatsapp}>
            Open WhatsApp chat
          </Button>
          <p className="mt-1.5 text-[12.5px] text-muted">Opens their chat with the message written. Attach the poster you downloaded, then send — MahekOne sends nothing itself.</p>
        </div>
      ) : props.whatsappBlocked ? (
        <p className="text-[12.5px] text-muted">{props.whatsappBlocked}</p>
      ) : null}
      {props.canRemove ? (
        <div className="border-t border-divider pt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const res = await toast.run(removePoster(props.posterId));
              if (res.ok) router.push("/studio/posters");
            }}
          >
            Remove from my posters
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
