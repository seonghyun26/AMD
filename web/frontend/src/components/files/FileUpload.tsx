"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { UploadCloud, CheckCircle2, AlertCircle } from "lucide-react";
import { uploadFile } from "@/lib/api";

interface Props {
  sessionId: string;
  onUploaded?: () => void;
  accept?: Record<string, string[]>;
  label?: string;
}

export default function FileUpload({ sessionId, onUploaded, accept, label }: Props) {
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!acceptedFiles.length) return;
      setStatus("uploading");
      try {
        for (const file of acceptedFiles) {
          await uploadFile(sessionId, file);
        }
        setStatus("done");
        setMessage(`${acceptedFiles.length} file(s) uploaded`);
        onUploaded?.();
        setTimeout(() => setStatus("idle"), 3000);
      } catch (err) {
        setStatus("error");
        setMessage(String(err));
      }
    },
    [sessionId, onUploaded]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: accept ?? {
      "chemical/x-pdb": [".pdb"],
      "application/octet-stream": [".gro", ".top", ".itp", ".tpr", ".cpt", ".pt", ".ckpt", ".pth"],
      "text/plain": [".mdp", ".dat", ".yaml", ".yml"],
    },
    multiple: true,
  });

  return (
    <div
      {...getRootProps()}
      className={`border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors text-xs ${
        isDragActive
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
          : "border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600"
      }`}
    >
      <input {...getInputProps()} />
      {status === "uploading" ? (
        <p className="text-gray-500">Uploading…</p>
      ) : status === "done" ? (
        <p className="text-green-600 flex items-center justify-center gap-1">
          <CheckCircle2 size={12} /> {message}
        </p>
      ) : status === "error" ? (
        <p className="text-red-500 flex items-center justify-center gap-1">
          <AlertCircle size={12} /> {message}
        </p>
      ) : (
        <div className="text-gray-400">
          <UploadCloud size={18} className="mx-auto mb-1" />
          <p>{label ?? "Drop PDB/GRO/TOP files here"}</p>
        </div>
      )}
    </div>
  );
}
