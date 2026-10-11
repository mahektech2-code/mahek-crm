"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { erpMarkLabelsPrinted } from "@/lib/actions/erp-trace";
import { Button } from "@/components/ui/primitives";
import { printRuns } from "@/lib/erp/engines/labels";
import { dots, qrGrid, rasterFromRgba, tsplJob, type PrinterSetup, type Raster } from "@/lib/erp/engines/tspl";
import { LABEL_CSS } from "./label-css";

/*
 * THREE WAYS TO PAPER, one set of labels.
 *
 *   Send to label printer   the labels go straight to a USB label printer as
 *                           printer commands. No dialog, no driver, no paper
 *                           size to get wrong — where the browser can reach
 *                           the printer (Chrome or Edge).
 *   Save print file         the same commands as a .prn file, for a printer
 *                           this browser cannot reach.
 *   Print                   the browser's own print dialog, as it always was.
 *
 * The printer is sent a PICTURE of each label, taken from the label on this
 * page under the page's own stylesheet — so the three routes cannot print
 * three different labels.
 */

/* WebUSB, as much of it as is used here. The browser's own types are not in lib.dom. */
type UsbEndpoint = { endpointNumber: number; direction: "in" | "out"; type: string };
type UsbAlternate = { alternateSetting: number; interfaceClass: number; endpoints: UsbEndpoint[] };
type UsbInterface = { interfaceNumber: number; alternates: UsbAlternate[] };
type UsbDevice = {
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
  productName?: string | null;
  opened: boolean;
  configuration: { interfaces: UsbInterface[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  selectAlternateInterface(i: number, a: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<{ status: string }>;
};
type Usb = { getDevices(): Promise<UsbDevice[]>; requestDevice(o: { filters: { classCode: number }[] }): Promise<UsbDevice> };

/** USB's class for printers. */
const PRINTER_CLASS = 7;

const usbOf = (): Usb | null => (typeof navigator !== "undefined" && "usb" in navigator ? (navigator as unknown as { usb: Usb }).usb : null);

const printerPort = (d: UsbDevice) => {
  for (const i of d.configuration?.interfaces ?? [])
    for (const a of i.alternates) {
      const out = a.interfaceClass === PRINTER_CLASS ? a.endpoints.find((e) => e.direction === "out" && e.type === "bulk") : undefined;
      if (out) return { iface: i.interfaceNumber, alt: a.alternateSetting, endpoint: out.endpointNumber };
    }
  return null;
};

const nameOf = (d: UsbDevice) => `${d.vendorId}:${d.productId}:${d.serialNumber ?? ""}`;

/* Which printer this size of label last went to, on this computer — a godown with a 50 mm printer and an 80 mm one picks each once. */
const remembered = (mm: number): string | null => {
  try {
    return localStorage.getItem(`erp.labelPrinter.${mm}`);
  } catch {
    return null;
  }
};
const remember = (mm: number, d: UsbDevice) => {
  try {
    localStorage.setItem(`erp.labelPrinter.${mm}`, nameOf(d));
  } catch {
    /* A private window: it asks again next time. */
  }
};

async function choosePrinter(usb: Usb, mm: number, ask: boolean): Promise<UsbDevice> {
  if (!ask) {
    const known = await usb.getDevices();
    const last = remembered(mm);
    const hit = known.find((d) => nameOf(d) === last) ?? (known.length === 1 ? known[0] : undefined);
    if (hit) return hit;
  }
  return usb.requestDevice({ filters: [{ classCode: PRINTER_CLASS }] });
}

async function sendUsb(d: UsbDevice, bytes: Uint8Array): Promise<void> {
  if (!d.opened) await d.open();
  try {
    if (!d.configuration) await d.selectConfiguration(1);
    const port = printerPort(d);
    if (!port) throw new Error("That device is not a printer this page can send to.");
    await d.claimInterface(port.iface);
    try {
      if (port.alt) await d.selectAlternateInterface(port.iface, port.alt);
      /* In pieces: a roll's worth of labels is megabytes, and a printer takes it as fast as it prints. */
      const piece = 16 * 1024;
      for (let at = 0; at < bytes.length; at += piece) {
        const res = await d.transferOut(port.endpoint, bytes.slice(at, at + piece));
        if (res.status !== "ok") throw new Error("The printer stopped accepting the labels. Check it has labels loaded and is not paused.");
      }
    } finally {
      await d.releaseInterface(port.iface).catch(() => {});
    }
  } finally {
    await d.close().catch(() => {});
  }
}

/** Why the printer could not be reached, in words somebody at a packing table can act on. */
function usbProblem(e: unknown): string | null {
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : String(e);
  /* Closing the chooser is a decision, not a failure. */
  if (name === "NotFoundError" && /no device selected/i.test(message)) return null;
  if (name === "SecurityError" || /access denied/i.test(message))
    return "This computer is keeping the printer for its own printer driver, so the browser cannot send to it. Use Print, or Save print file.";
  if (name === "NetworkError" || name === "NotFoundError") return "The printer did not answer. Check it is switched on and plugged in, then try again.";
  return message || "The labels could not be sent to the printer.";
}

/** A picture of one label, in the printer's own dots. */
async function rasterise(node: HTMLElement, mm: number, dotsPerMm: number): Promise<Raster> {
  const side = dots(mm, dotsPerMm);
  const px = (mm * 96) / 25.4;
  const markup = new XMLSerializer().serializeToString(node.cloneNode(true));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${px} ${px}">` +
    `<foreignObject x="0" y="0" width="${px}" height="${px}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${px}px;height:${px}px;background:#fff"><style>${LABEL_CSS.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</style>${markup}</div>` +
    `</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const c = canvas.getContext("2d", { willReadFrequently: true });
  if (!c) throw new Error("This browser cannot draw the labels for the printer.");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, side, side);
  c.drawImage(img, 0, 0, side, side);

  /* Each QR is drawn again from its modules, on whole dots: see `qrGrid`. */
  const box = node.getBoundingClientRect();
  const scale = box.width ? side / box.width : 0;
  for (const q of Array.from(node.querySelectorAll<SVGElement>("[data-qr]"))) {
    const [n, bits] = (q.dataset.qr ?? "").split(":");
    const size = Number(n);
    const r = q.getBoundingClientRect();
    if (!size || !bits || !scale) continue;
    const x = Math.round((r.left - box.left) * scale);
    const y = Math.round((r.top - box.top) * scale);
    const w = Math.round(r.width * scale);
    const { cell, offset } = qrGrid(size, w);
    c.fillStyle = "#fff";
    c.fillRect(x - 1, y - 1, w + 2, w + 2);
    c.fillStyle = "#000";
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (bits[row * size + col] === "1") c.fillRect(x + offset + col * cell, y + offset + row * cell, cell, cell);
  }
  return rasterFromRgba(c.getImageData(0, 0, side, side).data, side, side);
}

/** Every label on the page as one print job: the same label several times is one picture and a count. */
export async function buildJob(mm: number, setup: PrinterSetup): Promise<Uint8Array> {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(".label-sheet .lb"));
  const runs = printRuns(nodes, (n) => n.dataset.key ?? "");
  const labels = [];
  for (const run of runs) labels.push({ widthMm: mm, heightMm: mm, raster: await rasterise(run.item, mm, setup.dotsPerMm), copies: run.copies });
  return tsplJob(labels, setup);
}

function saveFile(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const noop = () => () => {};

export function LabelPrinter({ ids, count, what, mm, setup, fileName }: { ids: string[]; count: number; what: string; mm: number; setup: PrinterSetup; fileName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  /* Whether this browser can reach a USB printer is only known in the browser, so the server draws without the button. */
  const direct = useSyncExternalStore(noop, () => usbOf() != null, () => false);
  const labels = `${count} ${what}${count === 1 ? "" : "s"}`;

  /* For box labels: each box says when its label was printed, and how many times. */
  const mark = async () => {
    if (!ids.length) return;
    const res = await erpMarkLabelsPrinted(ids);
    if (!res.ok) setNote({ tone: "bad", text: res.error });
  };

  const send = (ask: boolean) =>
    start(async () => {
      const usb = usbOf();
      if (!usb) return;
      setNote(null);
      try {
        const device = await choosePrinter(usb, mm, ask);
        const job = await buildJob(mm, setup);
        await sendUsb(device, job);
        remember(mm, device);
        setNote({ tone: "ok", text: `${labels} sent to ${device.productName?.trim() || "the label printer"}.` });
        await mark();
        router.refresh();
      } catch (e) {
        const text = usbProblem(e);
        if (text) setNote({ tone: "bad", text });
      }
    });

  const save = () =>
    start(async () => {
      setNote(null);
      try {
        saveFile(await buildJob(mm, setup), fileName);
        setNote({ tone: "ok", text: `Saved ${fileName}: ${labels} at ${mm} × ${mm} mm.` });
        await mark();
        router.refresh();
      } catch (e) {
        setNote({ tone: "bad", text: e instanceof Error && e.message ? e.message : "The print file could not be made in this browser. Use Print." });
      }
    });

  const dialog = () =>
    start(async () => {
      await mark();
      window.print();
      router.refresh();
    });

  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {note ? <span className={`text-[12px] ${note.tone === "bad" ? "text-danger" : "text-ink-muted"}`}>{note.text}</span> : null}
      {direct ? (
        <>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => send(true)} title="Pick which USB printer these labels go to">
            Change printer
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => send(false)} title={`Send straight to the ${mm} mm label printer`}>
            Send {labels} to printer
          </Button>
        </>
      ) : null}
      <Button disabled={pending} onClick={save} title="The same printer commands as a file, for a printer this browser cannot reach">
        Save print file
      </Button>
      <Button variant={direct ? "secondary" : "primary"} disabled={pending} onClick={dialog} title="The browser's own print dialog">
        {direct ? "Print…" : `Print ${labels}`}
      </Button>
    </span>
  );
}
