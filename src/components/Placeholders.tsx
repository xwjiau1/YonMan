/* MVP 占位页：对话 Tab / 资产库 */
import { Library, Lock, MessageSquareText, Send } from "lucide-react";

function PlaceholderShell({ icon, title, desc, foot }: { icon: React.ReactNode; title: string; desc: string; foot?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-white">
      <div className="flex w-[380px] flex-col items-center gap-3 rounded-xl border border-[#E7ECF0] px-8 py-12 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#F6F8FA] text-[#59636E]">{icon}</span>
        <div className="flex items-center gap-1.5 text-[15px] font-semibold text-[#1F2328]">
          <Lock size={14} className="text-[#9A6700]" /> {title}
        </div>
        <div className="text-sm leading-6 text-[#59636E]">{desc}</div>
        {foot && <div className="mt-1 rounded-md bg-[#F6F8FA] px-3 py-1.5 text-xs text-[#9A6700]">{foot}</div>}
      </div>
    </div>
  );
}

export function ChatPlaceholder() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <PlaceholderShell
        icon={<MessageSquareText size={26} />}
        title="对话"
        desc="基于项目过程资产的 AI 对话助手将于后续迭代提供：自动引用会议纪要、日志与交付物上下文，回答项目相关问题。"
      />
      {/* 禁用态输入框，示意未来形态 */}
      <div className="shrink-0 px-6 pb-6">
        <div className="mx-auto flex max-w-[640px] items-center gap-2 rounded-xl border border-[#D1D9E0] bg-[#F6F8FA] px-4 py-3 text-sm text-[#8b949e]">
          向 YonMan 提问，例如「上周例会定了哪些待办？」
          <span className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg bg-[#E7ECF0] text-[#B7C0CC]"><Send size={13} /></span>
        </div>
      </div>
    </div>
  );
}

export function AssetPlaceholder() {
  return (
    <PlaceholderShell
      icon={<Library size={26} />}
      title="资产库"
      desc="企业级模板与过程资产库将于 V1.1 提供：会议纪要模板、实施方案框架、交付物清单等，可一键引用到当前项目节点。"
      foot="敬请期待后续版本"
    />
  );
}
