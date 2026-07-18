"use client";

export default function AssistantAvatar({ size = 36 }: { size?: number }) {
  return (
    <div
      className="amd-ai-avatar-frame flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size }}
      aria-label="AMD AI assistant"
      role="img"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/ai-assistant-avatar-simple.webp"
        alt=""
        className="h-full w-full rounded-full object-cover"
      />
    </div>
  );
}
