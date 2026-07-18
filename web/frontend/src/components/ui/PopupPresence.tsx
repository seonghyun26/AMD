"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

interface PopupPresenceProps {
  show: boolean;
  children: ReactNode;
  duration?: number;
}

/** Keeps popup content mounted long enough for its reverse closing motion. */
export default function PopupPresence({ show, children, duration = 500 }: PopupPresenceProps) {
  const [present, setPresent] = useState(show);
  const [closing, setClosing] = useState(false);
  const retainedChildren = useRef(children);
  if (show) retainedChildren.current = children;

  useEffect(() => {
    if (show) {
      setPresent(true);
      setClosing(false);
      return;
    }
    if (!present) return;

    setClosing(true);
    const timer = window.setTimeout(() => {
      setPresent(false);
      setClosing(false);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [duration, present, show]);

  if (!present) return null;

  return (
    <div className={closing ? "amd-popup-presence-closing" : undefined} style={{ display: "contents" }}>
      {retainedChildren.current}
    </div>
  );
}
