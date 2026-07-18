"use client";

import { X } from "lucide-react";

interface PopupTailCloseProps {
  onClick: () => void;
  label?: string;
}

export default function PopupTailClose({ onClick, label = "Close popup" }: PopupTailCloseProps) {
  return (
    <button type="button" className="amd-popup-tail-close" onClick={onClick} aria-label={label} title={label}>
      <X size={14} />
    </button>
  );
}
