/* 回收站弹窗 —— 30 天暂存，可还原/彻底删除 */
import { FileText, Folder, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, formatTime } from "@/lib/api";
import type { TrashItem } from "@/lib/api";
import { ConfirmDialog, Modal, OutlineButton, PrimaryButton, Tag } from "./common";

export function TrashDialog({ pid, open, onClose, onChanged }: { pid: string; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [purgeFor, setPurgeFor] = useState<TrashItem | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.getTrash(pid);
      setItems(r.items);
    } catch (e: any) {
      toast.error(e.message || "加载回收站失败");
    }
  }, [pid]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const doRestore = async (t: TrashItem) => {
    try {
      const r = await api.restoreTrash(pid, t.id);
      toast.success(`已还原到 ${r.restored_to}`);
      await load();
      onChanged();
    } catch (e: any) {
      toast.error(e.message || "还原失败");
    }
  };

  const doPurge = async () => {
    if (!purgeFor) return;
    try {
      await api.purgeTrash(pid, purgeFor.id);
      toast.success("已彻底删除，无法恢复");
      setPurgeFor(null);
      await load();
      onChanged();
    } catch (e: any) {
      toast.error(e.message || "删除失败");
    }
  };

  const doEmpty = async () => {
    try {
      const r = await api.emptyTrash(pid);
      toast.success(`已清空回收站（${r.purged} 项）`);
      setEmptyOpen(false);
      await load();
      onChanged();
    } catch (e: any) {
      toast.error(e.message || "清空失败");
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="回收站"
        width={720}
        footer={
          <>
            <span className="mr-auto text-xs text-[#8b949e]">删除的节点与文档暂存 30 天，超期自动清除</span>
            <OutlineButton onClick={onClose}>关闭</OutlineButton>
            <PrimaryButton onClick={() => setEmptyOpen(true)}>清空回收站</PrimaryButton>
          </>
        }
      >
        {!items ? (
          <div className="py-10 text-center text-sm text-[#59636E]">加载中…</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Trash2 size={26} className="text-[#B7C0CC]" />
            <div className="text-sm text-[#59636E]">回收站是空的</div>
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0">
            <thead>
              <tr className="bg-[#F6F8FA] text-left text-xs text-[#59636E]">
                <th className="rounded-l-md px-3 py-2 font-medium">名称</th>
                <th className="w-[220px] px-3 py-2 font-medium">原位置</th>
                <th className="w-[140px] px-3 py-2 font-medium">删除时间</th>
                <th className="w-[90px] px-3 py-2 font-medium">剩余</th>
                <th className="w-[130px] rounded-r-md px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="text-sm hover:bg-[#F6F8FA]">
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      {t.kind === "node" ? <Folder size={15} className="text-[#9A6700]" /> : <FileText size={15} className="text-[#59636E]" />}
                      <span className="truncate text-[#1F2328]" title={t.name}>{t.name}</span>
                      <Tag color={t.kind === "node" ? "orange" : "gray"}>{t.kind === "node" ? "阶段" : "文档"}</Tag>
                    </div>
                  </td>
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5">
                    <span className="block truncate text-xs text-[#59636E]" title={t.original_path}>{t.original_path}</span>
                  </td>
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5 text-xs text-[#59636E]">{formatTime(t.deleted_at)}</td>
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5">
                    <Tag color={t.remaining_days <= 7 ? "red" : "green"}>{t.remaining_days} 天</Tag>
                  </td>
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <OutlineButton className="!h-7 !px-2.5 text-xs" onClick={() => doRestore(t)}>
                        <RotateCcw size={12} /> 还原
                      </OutlineButton>
                      <OutlineButton className="!h-7 !px-2.5 text-xs !text-[#CF222E] hover:!bg-[#FFEBE9]" onClick={() => setPurgeFor(t)}>
                        <Trash2 size={12} /> 彻底删除
                      </OutlineButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <ConfirmDialog open={!!purgeFor} onClose={() => setPurgeFor(null)} onConfirm={doPurge} title="彻底删除" confirmText="彻底删除" danger>
        {purgeFor && (
          <>
            <p>彻底删除后，<b className="text-[#CF222E]">{purgeFor.name}</b> 及其内容将无法恢复。</p>
            {purgeFor.kind === "node" && <p className="mt-2 text-xs">若该阶段包含文档，其历史版本归档也将一并清除。</p>}
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog open={emptyOpen} onClose={() => setEmptyOpen(false)} onConfirm={doEmpty} title="清空回收站" confirmText="全部彻底删除" danger>
        将彻底删除回收站中的 {items?.length ?? 0} 项内容，<b className="text-[#CF222E]">操作后无法恢复</b>。确定继续吗？
      </ConfirmDialog>
    </>
  );
}
