/* 顶部导航栏 —— 高 60px，Figma Primer 亮色规范 */
import { Check, ChevronDown, FolderKanban } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@/lib/api";

export type MainTab = "process" | "chat";

export function Header({
  ws,
  workspaces,
  onSwitchWs,
  tab,
  onTabChange,
  onHome,
}: {
  ws: Workspace;
  workspaces: Workspace[];
  onSwitchWs: (ws: Workspace) => void;
  tab: MainTab;
  onTabChange: (t: MainTab) => void;
  onHome: () => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switcherOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) setSwitcherOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [switcherOpen]);

  const tabs: { key: MainTab; label: string }[] = [
    { key: "process", label: "过程" },
    { key: "chat", label: "对话" },
  ];

  return (
    <header className="flex h-[60px] shrink-0 items-center gap-4 border-b border-[#D1D9E0] bg-white px-4">
      {/* 品牌 */}
      <button className="flex items-center gap-2.5 ym-focus rounded-md" onClick={onHome} title="返回项目列表">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0969DA] text-sm font-bold text-white">Y</span>
        <span className="text-[15px] font-semibold tracking-tight text-[#1F2328]">YonMan 智能项目管理工作台</span>
      </button>

      {/* 项目切换器 */}
      <div className="relative" ref={switcherRef}>
        <button
          className="flex h-9 items-center gap-1.5 rounded-md border border-[#D1D9E0] bg-white px-3 text-sm text-[#1F2328] hover:bg-[#F6F8FA] ym-focus"
          onClick={() => setSwitcherOpen((v) => !v)}
        >
          <FolderKanban size={15} className="text-[#59636E]" />
          <span className="max-w-[200px] truncate">{ws.name}</span>
          <ChevronDown size={14} className="text-[#59636E]" />
        </button>
        {switcherOpen && (
          <div
            className="absolute left-0 top-11 z-40 w-[300px] rounded-xl border border-[#D1D9E0] bg-white py-1.5"
            style={{ boxShadow: "0 16px 32px rgba(140,149,159,0.2)" }}
          >
            <div className="px-3 pb-1 pt-1.5 text-xs text-[#59636E]">最近打开（最多 10 个）</div>
            {workspaces.map((w) => {
              const active = w.id === ws.id;
              return (
                <button
                  key={w.id}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#DDF4FF] ${active ? "bg-[#DDF4FF]" : ""}`}
                  onClick={() => { setSwitcherOpen(false); if (!active) onSwitchWs(w); }}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-[#0969DA]" : "bg-transparent"}`} />
                  <span className={`min-w-0 flex-1 truncate ${active ? "font-medium text-[#1F2328]" : "text-[#1F2328]"}`}>{w.name}</span>
                  {active && <Check size={14} className="shrink-0 text-[#0969DA]" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 主导航 Tab */}
      <nav className="ml-2 flex h-full items-stretch gap-1">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              className={`relative flex items-center px-4 text-sm ym-focus ${active ? "font-semibold text-[#1F2328]" : "text-[#59636E] hover:text-[#1F2328]"}`}
              onClick={() => onTabChange(t.key)}
            >
              {t.label}
              {active && <span className="absolute inset-x-3 bottom-0 h-[3px] rounded-t-full bg-[#FD8C73]" />}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* 环境标识 */}
      <span className="rounded-md bg-[#F6F8FA] px-2.5 py-1 text-xs font-medium text-[#9A6700]">本地环境</span>
      {/* 头像 */}
      <span
        className="flex h-8 w-8 items-center justify-center rounded-full bg-[#0969DA] text-xs font-semibold text-white"
        title={ws.manager || "项目负责人"}
      >
        {(ws.manager || "Y").slice(0, 1).toUpperCase()}
      </span>
    </header>
  );
}
