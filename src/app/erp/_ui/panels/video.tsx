"use client";

import { registerPanel, type PanelProps } from "../panels";

/* A help video plays inside the ERP: a YouTube link in the privacy-enhanced
   player, an uploaded file through the attachment endpoint that checks the
   viewer may open it. */

type Video = { youtube: string | null; file: string | null; url: string | null };

function VideoPanel({ data }: PanelProps) {
  const v = data as Video;
  if (v.youtube)
    return (
      <div className="relative overflow-hidden rounded-[6px] bg-ink pt-[56.25%]">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${v.youtube}`}
          title="Help video"
          allow="accelerometer; encrypted-media; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 h-full w-full border-0"
        />
      </div>
    );
  if (v.file) return <video src={`/api/attachments/${v.file}`} controls className="w-full rounded-[6px] bg-ink" />;
  return <span className="text-[13px] text-muted">{v.url ? "That link is not a YouTube video the ERP can play." : "No video attached."}</span>;
}

registerPanel("video", (p) => <VideoPanel {...p} />);
