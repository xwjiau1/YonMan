/* 阶段树面板 —— 240px 侧栏 */
import { ChevronDown, ChevronRight, Folder, FolderPlus, MessageSquareText, Plus, Search, StickyNote, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { NodeItem } from "@/lib/api";
import { ConfirmDialog, Modal, OutlineButton, PrimaryButton, YmInput } from "./common";

interface TreeCtx {
  pid: string;
  nodes: NodeItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  onOpenTrash: () => void;
}

type DropPos = "before" | "inside" | "after";

export function TreePanel({ ctx }: { ctx: TreeCtx }) {
  const { pid, nodes, selectedId, onSelect, onChanged, onOpenTrash } = ctx;
  const [keyword, setKeyword] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeItem } | null>(null);
  const [inline, setInline] = useState<{ kind: "add" | "rename"; node: NodeItem | null; value: string } | null>(null);
  const [remarkFor, setRemarkFor] = useState<NodeItem | null>(null);
  const [deleteFor, setDeleteFor] = useState<NodeItem | null>(null);
  const [deleteInfo, setDeleteInfo] = useState<{ docs: number; children: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; pos: DropPos } | null>(null);

  const childrenMap = useMemo(() => {
    const m = new Map<string | null, NodeItem[]>();
    for (const n of nodes) {
      const key = n.parent_id;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(n);
    }
    for (const list of m.values()) list.sort((a, b) => a.seq - b.seq);
    return m;
  }, [nodes]);

  /* 搜索：命中节点 + 其祖先保留 */
  const visibleSet = useMemo(() => {
    if (!keyword.trim()) return null;
    const kw = keyword.trim().toLowerCase();
    const keep = new Set<string>();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      if (n.name.toLowerCase().includes(kw)) {
        let cur: NodeItem | undefined = n;
        while (cur && !keep.has(cur.id)) {
          keep.add(cur.id);
          cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        }
      }
    }
    return keep;
  }, [nodes, keyword]);

  const toggleCollapse = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const submitInline = async () => {
    if (!inline) return;
    const name = inline.value.trim();
    if (!name) return setInline(null);
    try {
      if (inline.kind === "add") {
        await api.createNode(pid, { parent_id: inline.node ? inline.node.id : null, name });
        toast.success("已创建子阶段");
      } else {
        await api.renameNode(pid, inline.node!.id, name);
        toast.success("已重命名");
      }
      setInline(null);
      onChanged();
    } catch (e: any) {
      toast.error(e.message || "操作失败");
    }
  };

  const openDelete = async (n: NodeItem) => {
    setDeleteFor(n);
    try {
      const c = await api.nodeDocCount(pid, n.id);
      const countChildren = (id: string): number =>
        (childrenMap.get(id) || []).reduce((a, x) => a + 1 + countChildren(x.id), 0);
      setDeleteInfo({ docs: c.count, children: countChildren(n.id) });
    } catch {
      setDeleteInfo({ docs: n.doc_count, children: 0 });
    }
  };

  const doDelete = async () => {
    if (!deleteFor) return;
    try {
      const r = await api.deleteNode(pid, deleteFor.id);
      toast.success(`已移入回收暂存（含 ${r.doc_count} 份文档），30 天内可还原`);
      setDeleteFor(null);
      if (selectedId === deleteFor.id || isDescendant(deleteFor.id, selectedId)) onSelect("");
      onChanged();
    } catch (e: any) {
      toast.error(e.message || "删除失败");
    }
  };

  const isDescendant = (ancestorId: string, id: string | null): boolean => {
    if (!id) return false;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let cur = byId.get(id);
    while (cur) {
      if (cur.parent_id === ancestorId) return true;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return false;
  };

  const handleDrop = async (target: NodeItem | null, pos: DropPos) => {
    if (!dragId || dragId === target?.id) return;
    // 目标不能是拖拽节点的子孙
    if (target && (target.id === dragId || isDescendant(dragId, target.id))) {
      toast.error("不能移动到自身或其子阶段下");
      return;
    }
    const parentId = pos === "inside" ? (target ? target.id : null) : target ? target.parent_id : null;
    const siblings = (childrenMap.get(parentId) || []).filter((n) => n.id !== dragId);
    let index = siblings.length;
    if (target && pos !== "inside") {
      const ti = siblings.findIndex((n) => n.id === target.id);
      index = pos === "before" ? ti : ti + 1;
    }
    try {
      await api.moveNode(pid, dragId, parentId, index);
      onChanged();
    } catch (e: any) {
      toast.error(e.message || "移动失败");
    } finally {
      setDragId(null);
      setDropHint(null);
    }
  };

  const renderNode = (n: NodeItem, depth: number): React.ReactNode => {
    if (visibleSet && !visibleSet.has(n.id)) return null;
    const kids = childrenMap.get(n.id) || [];
    const isCollapsed = collapsed.has(n.id) && !visibleSet;
    const selected = n.id === selectedId;
    const hint = dropHint?.id === n.id ? dropHint.pos : null;
    const count = n.doc_count;

    return (
      <div key={n.id}>
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", n.id);
            e.dataTransfer.effectAllowed = "move";
            setDragId(n.id);
          }}
          onDragEnd={() => { setDragId(null); setDropHint(null); }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const ratio = (e.clientY - rect.top) / rect.height;
            const pos: DropPos = ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : "inside";
            setDropHint({ id: n.id, pos });
          }}
          onDragLeave={() => setDropHint((h) => (h?.id === n.id ? null : h))}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(n, dropHint?.pos || "inside"); }}
          onClick={() => onSelect(n.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            onSelect(n.id);
            setMenu({ x: e.clientX, y: e.clientY, node: n });
          }}
          onDoubleClick={() => setInline({ kind: "rename", node: n, value: n.name })}
          className={`group relative flex h-8 cursor-pointer items-center gap-1 rounded-md pr-2 text-sm ${
            selected ? "bg-[#DDF4FF] font-medium text-[#1F2328]" : "text-[#1F2328] hover:bg-[#EDF1F5]"
          } ${hint === "inside" ? "ring-2 ring-inset ring-[#0969DA]" : ""}`}
          style={{ paddingLeft: 6 + depth * 16 }}
        >
          {hint === "before" && <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded bg-[#0969DA]" />}
          {hint === "after" && <span className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded bg-[#0969DA]" />}
          <button
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#59636E] hover:bg-white/60"
            onClick={(e) => { e.stopPropagation(); if (kids.length) toggleCollapse(n.id); }}
          >
            {kids.length ? (isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />) : <span className="w-[13px]" />}
          </button>
          <Folder size={15} className={`shrink-0 ${selected ? "text-[#0969DA]" : "text-[#8b949e]"}`} />
          <span className="min-w-0 flex-1 truncate">{n.name}</span>
          {n.remark && <StickyNote size={12} className="shrink-0 text-[#9A6700]" />}
          {count > 0 && (
            <span className="shrink-0 rounded-full bg-[#F6F8FA] px-1.5 text-[11px] text-[#59636E] group-hover:bg-white">{count}</span>
          )}
          <button
            className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[#59636E] hover:bg-white hover:text-[#0969DA] group-hover:flex"
            title="新建子阶段"
            onClick={(e) => { e.stopPropagation(); setInline({ kind: "add", node: n, value: "" }); }}
          >
            <Plus size={13} />
          </button>
        </div>
        {inline && inline.node?.id === n.id && inline.kind === "add" && (
          <InlineInput
            value={inline.value}
            onChange={(v) => setInline({ ...inline, value: v })}
            onSubmit={submitInline}
            onCancel={() => setInline(null)}
            depth={depth + 1}
            placeholder="新子阶段名称，回车创建"
          />
        )}
        {!isCollapsed && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-[#D1D9E0] bg-[#F6F8FA]">
      {/* 面板头 */}
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <span className="text-xs font-semibold text-[#59636E]">阶段结构</span>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-[#59636E] hover:bg-[#EDF1F5] hover:text-[#0969DA] ym-focus"
          title="新建顶级阶段"
          onClick={() => setInline({ kind: "add", node: null, value: "" })}
        >
          <FolderPlus size={14} />
        </button>
      </div>
      {/* 搜索 */}
      <div className="relative px-3 pb-2">
        <Search size={13} className="pointer-events-none absolute left-5.5 top-1/2 -translate-y-1/2 text-[#8b949e]" style={{ left: 22 }} />
        <input
          className="h-8 w-full rounded-md border border-[#D1D9E0] bg-white pl-7 pr-2 text-xs placeholder:text-[#8b949e] ym-focus"
          placeholder="搜索阶段名称"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {/* 树 */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 ym-scrollbar"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId) handleDrop(null, "inside"); // 拖到空白 = 移到顶级末尾
        }}
      >
        {inline && inline.kind === "add" && inline.node === null && (
          <InlineInput value={inline.value} onChange={(v) => setInline({ ...inline, value: v })} onSubmit={submitInline} onCancel={() => setInline(null)} depth={0} placeholder="顶级阶段名称，回车创建" />
        )}
        {(childrenMap.get(null) || []).map((n) => renderNode(n, 0))}
        {nodes.length === 0 && <div className="px-3 py-8 text-center text-xs text-[#8b949e]">暂无阶段，点击右上角 + 创建</div>}
      </div>

      {/* 底部：回收站 */}
      <button
        className="mx-2 mb-2 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-[#59636E] hover:bg-[#EDF1F5] hover:text-[#1F2328] ym-focus"
        onClick={onOpenTrash}
      >
        <Trash2 size={14} /> 回收站
        <span className="ml-auto text-xs text-[#8b949e]">30 天</span>
      </button>

      {/* 右键菜单 */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 w-[160px] rounded-lg border border-[#D1D9E0] bg-white py-1"
            style={{ left: menu.x, top: menu.y, boxShadow: "0 8px 24px rgba(140,149,159,0.25)" }}
          >
            <MenuItem icon={<Plus size={14} />} onClick={() => { setInline({ kind: "add", node: menu.node, value: "" }); setMenu(null); }}>新建子节点</MenuItem>
            <MenuItem icon={<MessageSquareText size={14} />} onClick={() => { setInline({ kind: "rename", node: menu.node, value: menu.node.name }); setMenu(null); }}>重命名</MenuItem>
            <MenuItem icon={<StickyNote size={14} />} onClick={() => { setRemarkFor(menu.node); setMenu(null); }}>编辑备注</MenuItem>
            <div className="my-1 h-px bg-[#E7ECF0]" />
            <MenuItem danger icon={<Trash2 size={14} />} onClick={() => { openDelete(menu.node); setMenu(null); }}>删除</MenuItem>
          </div>
        </>
      )}

      {/* 备注弹窗 */}
      <RemarkDialog pid={pid} node={remarkFor} onClose={() => setRemarkFor(null)} onSaved={() => { setRemarkFor(null); onChanged(); }} />

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        onConfirm={doDelete}
        title="删除阶段"
        confirmText="移入回收暂存"
        danger
      >
        {deleteFor && (
          <>
            <p>
              确定删除阶段 <b className="text-[#1F2328]">{deleteFor.name}</b> 吗？
            </p>
            <p className="mt-2">
              {deleteInfo ? (
                <>该阶段含 <b className="text-[#1F2328]">{deleteInfo.children}</b> 个子阶段、<b className="text-[#1F2328]">{deleteInfo.docs}</b> 份文档。</>
              ) : (
                <>该阶段下的子阶段与文档将一并处理。</>
              )}
            </p>
            <p className="mt-2 rounded-md bg-[#FFF8E6] px-3 py-2 text-xs leading-5 text-[#9A6700]">
              删除后文件夹整体移入回收暂存（.yonman\trash），<b>30 天内可完整还原</b>；彻底删除后将无法恢复。
            </p>
          </>
        )}
      </ConfirmDialog>
    </aside>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${danger ? "text-[#CF222E] hover:bg-[#FFEBE9]" : "text-[#1F2328] hover:bg-[#F6F8FA]"}`}
      onClick={onClick}
    >
      {icon} {children}
    </button>
  );
}

function InlineInput({
  value, onChange, onSubmit, onCancel, depth, placeholder,
}: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; onCancel: () => void; depth: number; placeholder: string;
}) {
  return (
    <div style={{ paddingLeft: 6 + depth * 16 }} className="py-0.5 pr-2">
      <input
        autoFocus
        className="h-7 w-full rounded-md border border-[#0969DA] px-2 text-sm ym-focus"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onSubmit}
      />
    </div>
  );
}

function RemarkDialog({ pid, node, onClose, onSaved }: { pid: string; node: NodeItem | null; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const open = !!node;
  // 打开时同步初值
  const [lastId, setLastId] = useState<string | null>(null);
  if (node && node.id !== lastId) {
    setLastId(node.id);
    setValue(node.remark || "");
  }
  const save = async () => {
    if (!node) return;
    setBusy(true);
    try {
      await api.setRemark(pid, node.id, value.trim());
      toast.success("备注已保存");
      onSaved();
    } catch (e: any) {
      toast.error(e.message || "保存失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`编辑备注 — ${node?.name ?? ""}`} footer={<><OutlineButton onClick={onClose}>取消</OutlineButton><PrimaryButton onClick={save} disabled={busy}>保存</PrimaryButton></>}>
      <YmInput autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="记录该阶段的目标、范围或注意事项" />
      <p className="mt-2 text-xs text-[#8b949e]">备注会同步写入 .yonman\project.json，随项目空间保存。</p>
    </Modal>
  );
}
