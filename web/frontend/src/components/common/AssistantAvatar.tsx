"use client";

import { useId } from "react";

export default function AssistantAvatar({ size = 40 }: { size?: number }) {
  const gradientId = useId().replace(/:/g, "");
  const liquidClipId = `${gradientId}clip`;

  return (
    <div
      className="amd-ai-avatar-frame flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size }}
      aria-label="AMD AI assistant"
      role="img"
    >
      <svg
        className="h-full w-full drop-shadow-sm [--amd-agent-mark-accent-a:#22d3ee] [--amd-agent-mark-accent-b:#6366f1] [--amd-agent-mark-accent-c:#a78bfa] [--amd-agent-mark-face:#eef2ff] [--amd-agent-mark-ink:#312e81] dark:[--amd-agent-mark-accent-a:#a5f3fc] dark:[--amd-agent-mark-accent-b:#a5b4fc] dark:[--amd-agent-mark-accent-c:#e9d5ff] dark:[--amd-agent-mark-face:#253a78] dark:[--amd-agent-mark-ink:#f8fafc]"
        viewBox="8 8 48 48"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="8" y1="10" x2="56" y2="54" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--amd-agent-mark-accent-a)" />
            <stop offset="0.55" stopColor="var(--amd-agent-mark-accent-b)" />
            <stop offset="1" stopColor="var(--amd-agent-mark-accent-c)" />
          </linearGradient>
          <clipPath id={liquidClipId}>
            <path d="M28 15v11L18.5 43.5A4 4 0 0 0 22.1 49h19.8a4 4 0 0 0 3.6-5.5L36 26V15Z" />
          </clipPath>
        </defs>

        <circle cx="13" cy="25" r="1.8" fill="var(--amd-agent-mark-accent-a)" />
        <circle cx="51" cy="19" r="1.8" fill="var(--amd-agent-mark-accent-c)" />

        <path d="M25.5 15h13M28 15v11L18.5 43.5A4 4 0 0 0 22.1 49h19.8a4 4 0 0 0 3.6-5.5L36 26V15" fill="var(--amd-agent-mark-face)" stroke={`url(#${gradientId})`} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
        <g clipPath={`url(#${liquidClipId})`}>
          <path d="M17 37c5-3 8 2 13-.5 5-2.6 8 2.2 13-.4 3.2-1.7 5-.8 7 .5V52H17Z" fill={`url(#${gradientId})`} opacity="0.22" />
          <path d="M17 37c5-3 8 2 13-.5 5-2.6 8 2.2 13-.4 3.2-1.7 5-.8 7 .5" fill="none" stroke={`url(#${gradientId})`} strokeWidth="1.5" />
        </g>
        <circle cx="27.5" cy="40.5" r="1.65" fill="var(--amd-agent-mark-ink)" />
        <circle cx="36.5" cy="40.5" r="1.65" fill="var(--amd-agent-mark-ink)" />
        <path d="M29 45h6" stroke="var(--amd-agent-mark-ink)" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="32" cy="30" r="1.65" fill="var(--amd-agent-mark-accent-a)" opacity="0.8" />
        <circle cx="37" cy="34" r="1.1" fill="var(--amd-agent-mark-accent-c)" opacity="0.85" />
      </svg>
    </div>
  );
}
