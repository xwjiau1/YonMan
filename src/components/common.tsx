/* 通用 UI 组件 —— 严格对齐 Figma（Primer Light） */
import { X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";

/* ---------- 按钮 ---------- */
export function PrimaryButton({ children, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[#1F2329] px-4 text-sm font-medium text-white transition-colors hover:bg-[#33383f] disabled:cursor-not-allowed disabled:opacity-50 ym-focus ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function OutlineButton({ children, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[#D1D9E0] bg-white px-4 text-sm font-medium text-[#1F2328] transition-colors hover:bg-[#F6F8FA] disabled:cursor-not-allowed disabled:opacity-50 ym-focus ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function DangerButton({ children, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[#CF222E] px-4 text-sm font-medium text-white transition-colors hover:bg-[#b71d28] disabled:cursor-not-allowed disabled:opacity-50 ym-focus ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({ children, className = "", title, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      title={title}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-[#59636E] transition-colors hover:bg-[#F6F8FA] hover:text-[#1F2328] disabled:cursor-not-allowed disabled:opacity-40 ym-focus ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/* ---------- 输入 ---------- */
export function YmInput({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-md border border-[#D1D9E0] bg-white px-3 text-sm text-[#1F2328] placeholder:text-[#8b949e] ym-focus ${className}`}
      {...props}
    />
  );
}

/* ---------- 弹窗 ---------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: "rgba(31,35,40,0.5)" }} onClick={onClose} />
      <div
        className="relative flex max-h-[82vh] flex-col rounded-xl bg-white"
        style={{ width, boxShadow: "0 16px 32px rgba(140,149,159,0.2)" }}
        role="dialog"
        aria-modal
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-[#D1D9E0] px-5">
          <div className="text-base font-semibold text-[#1F2328]">{title}</div>
          <IconButton onClick={onClose} title="关闭">
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 ym-scrollbar">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[#D1D9E0] px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- 确认弹窗 ---------- */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmText = "确认",
  danger = false,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  confirmText?: string;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width={480}
      footer={
        <>
          <OutlineButton onClick={onClose}>取消</OutlineButton>
          {danger ? (
            <DangerButton onClick={onConfirm} disabled={busy}>{busy ? "处理中…" : confirmText}</DangerButton>
          ) : (
            <PrimaryButton onClick={onConfirm} disabled={busy}>{busy ? "处理中…" : confirmText}</PrimaryButton>
          )}
        </>
      }
    >
      <div className="text-sm leading-6 text-[#59636E]">{children}</div>
    </Modal>
  );
}

/* ---------- 标签 ---------- */
export function Tag({ children, color = "blue" }: { children: ReactNode; color?: "blue" | "gray" | "orange" | "red" | "green" }) {
  const map: Record<string, string> = {
    blue: "bg-[#DDF4FF] text-[#0969DA]",
    gray: "bg-[#F6F8FA] text-[#59636E]",
    orange: "bg-[#FFF8E6] text-[#9A6700]",
    red: "bg-[#FFEBE9] text-[#CF222E]",
    green: "bg-[#DAFBE1] text-[#1A7F37]",
  };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${map[color]}`}>{children}</span>
  );
}
