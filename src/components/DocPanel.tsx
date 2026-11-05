/* 文档面板 —— 5 大过程分区 + 文件表 + 上传/版本/预览 */
import {
  ChevronRight, Download, FileText, FolderOpen, MoreHorizontal, Package, Presentation,
  RefreshCw, Search, StickyNote, Upload, UploadCloud, ClipboardList, File,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  api, DOC_TYPE_LABEL, DOC_TYPES, formatSize, formatTime,
} from "@/lib/api";
import { electron } from "@/lib/electron";
import type { DocItem, DocType, DocsResponse, VersionItem } from "@/lib/api";
import { ConfirmDialog, IconButton, Modal, OutlineButton, PrimaryButton, Tag, YmInput } from "./common";

const TYPE_STYLE: Record<DocType, { icon: React.ElementType; fg: string; bg: string }> = {
  meeting: { icon: Presentation, fg: "text-[#0969DA]", bg: "bg-[#DDF4FF]" },
  log: { icon: FileText, fg: "text-[#1A7F37]", bg: "bg-[#DAFBE1]" },
  plan: { icon: ClipboardList, fg: "text-[#9A6700]", bg: "bg-[#FFF8E6]" },
  deliverable: { icon: Package, fg: "text-[#8250DF]", bg: "bg-[#FBEFFF]" },
  other: { icon: File, fg: "text-[#59636E]", bg: "bg-[#F6F8FA]" },
};

const VERSION_SOURCE_LABEL: Record<string, string> = {
  current: "当前版本",
  replace: "替换归档",
  "restore-prev": "还原前版本",
  scan: "扫描登记",
};

export function DocPanel({
  pid, nodeId, chainNames, chainFolders, winPath, onDocsChanged,
}: {
  pid: string;
  nodeId: string | null;
  chainNames: string[];
  chainFolders: string[];
  winPath: string;
  onDocsChanged?: () => void;
}) {
  const [data, setData] = useState<DocsResponse | null>(null);
  const [filter, setFilter] = useState<DocType | "all">("all");
  const [uploadState, setUploadState] = useState<{
    files: File[];
    targetType: DocType;
    existing: string[];
    policies: Record<string, "replace" | "keep" | "skip">;
  } | null>(null);
  const [versionsFor, setVersionsFor] = useState<DocItem | null>(null);
  const [preview, setPreview] = useState<{ doc: DocItem; version?: number } | null>(null);
  const [renameFor, setRenameFor] = useState<DocItem | null>(null);
  const [deleteFor, setDeleteFor] = useState<DocItem | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!nodeId) return;
    try {
      setData(await api.getDocs(pid, nodeId));
    } catch (e: any) {
      toast.error(e.message || "加载文档失败");
    }
  }, [pid, nodeId]);

  useEffect(() => { load(); }, [load]);

  /* 打开上传弹窗：拉取目标分类已有文件名做冲突检测 */
  const openUpload = async (files: File[], targetType?: DocType) => {
    if (!nodeId || !files.length) return;
    const t: DocType = targetType || (filter === "all" ? uploadState?.targetType || "meeting" : filter);
    let existing: string[] = [];
    try {
      const d = await api.getDocs(pid, nodeId);
      existing = d.items.filter((x) => x.doc_type === t).map((x) => x.file_name);
    } catch { /* ignore */ }
    const conflicts = files.map((f) => f.name).filter((n) => existing.includes(n));
    const policies: Record<string, "replace" | "keep" | "skip"> = {};
    for (const n of conflicts) policies[n] = "replace";
    setUploadState({ files, targetType: t, existing, policies });
  };

  /* 文件选择器回调：弹窗已开则追加，未开则新建 */
  const handlePicked = async (files: File[], targetType?: DocType) => {
    if (!files.length) return;
    if (uploadState) {
      const merged = [...uploadState.files, ...files];
      const newConflicts = files.map((f) => f.name).filter((n) => uploadState.existing.includes(n) && !uploadState.policies[n]);
      const policies = { ...uploadState.policies };
      for (const n of newConflicts) policies[n] = "replace";
      setUploadState({ ...uploadState, files: merged, policies });
    } else {
      await openUpload(files, targetType);
    }
  };

  const doUpload = async () => {
    if (!uploadState || !nodeId) return;
    const { files, targetType, policies } = uploadState;
    try {
      const r = await api.uploadDocs(pid, nodeId, targetType, files, policies);
      const parts: string[] = [];
      if (r.uploaded.length) parts.push(`已上传 ${r.uploaded.length} 个`);
      if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 个`);
      if (r.failed.length) parts.push(`失败 ${r.failed.length} 个`);
      if (r.failed.length) toast.error(`上传完成：${parts.join("，")}`, { description: r.failed.map((f) => `${f.file_name}：${f.error}`).join("\n") });
      else toast.success(`上传完成：${parts.join("，")}`);
      setUploadState(null);
      await load();
      onDocsChanged?.();
    } catch (e: any) {
      toast.error(e.message || "上传失败");
    }
  };

  const doScan = async () => {
    try {
      const r = await api.scan(pid);
      const s = r.summary;
      const parts = [`新登记 ${s.registered}`, `缺失 ${s.missing}`, `恢复 ${s.recovered}`];
      if (s.loose_files.length || s.unregistered_folders.length || s.broken_nodes.length) {
        parts.push(`游离文件 ${s.loose_files.length}`, `未登记目录 ${s.unregistered_folders.length}`, `异常节点 ${s.broken_nodes.length}`);
      }
      toast.success("刷新完成：" + parts.join(" · "));
      await load();
      onDocsChanged?.();
    } catch (e: any) {
      toast.error(e.message || "刷新失败");
    }
  };

  const items = useMemo(() => {
    if (!data) return [];
    return filter === "all" ? data.items : data.items.filter((x) => x.doc_type === filter);
  }, [data, filter]);

  const totalCount = useMemo(() => (data ? DOC_TYPES.reduce((a, t) => a + (data.counts[t] || 0), 0) : 0), [data]);

  const revealPath = async (doc: DocItem) => {
    if (electron) {
      try {
        await electron.reveal(doc.real_path);
      } catch {
        toast.error("无法打开资源管理器");
      }
      return;
    }
    const chain = (chainFolders.length ? chainFolders : chainNames).join("\\");
    toast.info(`${winPath}\\${chain}\\${doc.doc_type}\\${doc.file_name}`, { description: "Web 版仅显示路径，桌面客户端将打开资源管理器定位" });
  };

  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) openUpload(files);
  };

  if (!nodeId) {
    return (
      <div className="flex flex-1 items-center justify-center bg-white">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-[#D1D9E0] text-[#8b949e]"><FolderOpen size={24} /></div>
          <div className="text-sm font-medium text-[#1F2328]">请选择左侧的阶段节点</div>
          <div className="text-xs text-[#59636E]">文档按阶段归档到五大过程分区：会议纪要 / 工作日志 / 计划方案 / 交付物 / 其他</div>
        </div>
      </div>
    );
  }

  const nodeName = data?.node.name || chainNames[chainNames.length - 1] || "";

  return (
    <div
      className={`flex min-w-0 flex-1 flex-col bg-white ${dragOver ? "ring-2 ring-inset ring-[#0969DA]" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDropFiles}
    >
      {/* 面包屑 + 操作区 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#D1D9E0] px-5 py-3">
        <nav className="flex min-w-0 items-center gap-1 text-xs text-[#59636E]">
          <span className="text-[#8b949e]">工作台</span>
          {chainNames.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={12} className="text-[#B7C0CC]" />
              <span className={i === chainNames.length - 1 ? "font-medium text-[#1F2328]" : ""}>{c}</span>
            </span>
          ))}
        </nav>
        <div className="flex-1" />
        <OutlineButton className="!h-8 text-xs" onClick={doScan} title="扫描磁盘变化：新文件登记、丢失标记、恢复检测">
          <RefreshCw size={13} /> 刷新
        </OutlineButton>
        <OutlineButton
          className="!h-8 border-dashed text-xs"
          onClick={() => toast.info("资产库将于 V1.1 版本提供，届时可一键引用标准模板")}
        >
          <Upload size={13} className="rotate-180" /> 从资产库引用模板
        </OutlineButton>
        <PrimaryButton className="!h-8 text-xs" onClick={() => fileInput.current?.click()}>
          <Upload size={13} /> 上传文件
        </PrimaryButton>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            handlePicked(files);
          }}
        />
      </div>

      {/* 节点标题 */}
      <div className="flex shrink-0 items-center gap-2 px-5 pb-1 pt-4">
        <h1 className="text-lg font-semibold text-[#1F2328]">{nodeName}</h1>
        {data?.node.remark && (
          <span className="flex max-w-[400px] items-center gap-1 truncate text-xs text-[#9A6700]" title={data.node.remark}>
            <StickyNote size={12} /> {data.node.remark}
          </span>
        )}
        <span className="text-xs text-[#8b949e]">共 {totalCount} 份文档</span>
      </div>

      {/* 文档类型卡片 */}
      <div className="flex shrink-0 gap-2 overflow-x-auto px-5 pb-3 pt-3 ym-scrollbar">
        <TypeCard active={filter === "all"} label="全部" count={totalCount} onClick={() => setFilter("all")} onUpload={() => fileInput.current?.click()} />
        {DOC_TYPES.map((t) => (
          <TypeCard
            key={t}
            active={filter === t}
            label={DOC_TYPE_LABEL[t]}
            count={data?.counts[t] || 0}
            icon={TYPE_STYLE[t].icon}
            fg={TYPE_STYLE[t].fg}
            bg={TYPE_STYLE[t].bg}
            onClick={() => setFilter(t)}
            onUpload={() => openUpload([], t).then(() => fileInput.current?.click())}
          />
        ))}
      </div>

      {/* 文件表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 ym-scrollbar">
        {items.length === 0 ? (
          <div
            className="flex cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed border-[#D1D9E0] py-14 text-center"
            onClick={() => fileInput.current?.click()}
          >
            <UploadCloud size={30} className="text-[#8b949e]" />
            <div className="text-sm font-medium text-[#1F2328]">拖拽文件到此处，或点击选择文件</div>
            <div className="text-xs text-[#59636E]">
              {filter === "all" ? "上传时请在上传窗口中选择目标分类" : `将上传到「${DOC_TYPE_LABEL[filter as DocType]}」分区`}
            </div>
            <PrimaryButton className="mt-1 !h-8 text-xs">选择文件</PrimaryButton>
          </div>
        ) : (
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-10">
              <tr className="bg-[#F6F8FA] text-left text-xs text-[#59636E]">
                <th className="rounded-l-md px-3 py-2 font-medium">名称</th>
                <th className="w-[90px] px-3 py-2 font-medium">大小</th>
                <th className="w-[150px] px-3 py-2 font-medium">修改时间</th>
                <th className="w-[140px] px-3 py-2 font-medium">版本</th>
                <th className="w-[100px] rounded-r-md px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((doc) => (
                <tr key={doc.id} className="group text-sm hover:bg-[#F6F8FA]">
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <FileText size={15} className={`shrink-0 ${doc.missing ? "text-[#CF222E]" : "text-[#59636E]"}`} />
                      <span className={`truncate ${doc.missing ? "text-[#8b949e] line-through" : "text-[#1F2328]"}`} title={doc.file_name}>
                        {doc.file_name}
                      </span>
                      {doc.missing && <Tag color="red">缺失</Tag>}
                      <Tag color="gray">{DOC_TYPE_LABEL[doc.doc_type]}</Tag>
                    </div>
                  </td>
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5 text-[#59636E]">{doc.missing ? "—" : formatSize(doc.size)}</td>
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5 text-[#59636E]">{doc.missing ? "—" : formatTime(doc.mtime)}</td>
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <Tag color={doc.current_version > 1 ? "blue" : "gray"}>v{doc.current_version}</Tag>
                      <button className="text-xs text-[#0969DA] hover:underline" onClick={() => setVersionsFor(doc)}>历史</button>
                    </div>
                  </td>
                  <td className="border-b border-[#E7ECF0] px-3 py-2.5">
                    <div className="flex items-center justify-end gap-0.5">
                      <IconButton title="下载" disabled={doc.missing} onClick={() => window.open(api.downloadDoc(pid, doc.id), "_blank")}>
                        <Download size={15} />
                      </IconButton>
                      <div className="relative">
                        <IconButton title="更多" onClick={() => setMenuFor(menuFor === doc.id ? null : doc.id)}>
                          <MoreHorizontal size={15} />
                        </IconButton>
                        {menuFor === doc.id && (
                          <>
                            <div className="fixed inset-0 z-30" onClick={() => setMenuFor(null)} />
                            <div
                              className="absolute right-0 z-40 w-[150px] rounded-lg border border-[#D1D9E0] bg-white py-1"
                              style={{ boxShadow: "0 8px 24px rgba(140,149,159,0.25)" }}
                            >
                              <RowMenu onClick={() => { setMenuFor(null); setPreview({ doc }); }}>打开</RowMenu>
                              <RowMenu onClick={() => { setMenuFor(null); revealPath(doc); }}>打开所在位置</RowMenu>
                              <RowMenu onClick={() => { setMenuFor(null); setRenameFor(doc); }}>重命名</RowMenu>
                              <RowMenu onClick={() => { setMenuFor(null); setVersionsFor(doc); }}>版本记录</RowMenu>
                              <div className="my-1 h-px bg-[#E7ECF0]" />
                              <RowMenu danger onClick={() => { setMenuFor(null); setDeleteFor(doc); }}>删除</RowMenu>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 上传弹窗 */}
      {uploadState && (
        <UploadDialog
          state={uploadState}
          onClose={() => setUploadState(null)}
          onChange={(s) => setUploadState(s)}
          onConfirm={doUpload}
          onPickMore={() => fileInput.current?.click()}
        />
      )}

      {/* 版本时间线 */}
      {versionsFor && <VersionsDialog pid={pid} doc={versionsFor} onClose={() => setVersionsFor(null)} onChanged={load} />}

      {/* 预览 */}
      {preview && <PreviewDialog pid={pid} doc={preview.doc} version={preview.version} onClose={() => setPreview(null)} />}

      {/* 重命名 */}
      <RenameDocDialog pid={pid} doc={renameFor} onClose={() => setRenameFor(null)} onDone={() => { setRenameFor(null); load(); }} />

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        onConfirm={async () => {
          if (!deleteFor) return;
          try {
            await api.deleteDoc(pid, deleteFor.id);
            toast.success("已移入回收暂存，30 天内可在回收站还原");
            setDeleteFor(null);
            load();
            onDocsChanged?.();
          } catch (e: any) {
            toast.error(e.message || "删除失败");
          }
        }}
        title="删除文档"
        confirmText="移入回收暂存"
        danger
      >
        {deleteFor && (
          <>
            <p>确定删除 <b className="text-[#1F2328]">{deleteFor.file_name}</b> 吗？</p>
            <p className="mt-2 rounded-md bg-[#FFF8E6] px-3 py-2 text-xs leading-5 text-[#9A6700]">
              文件将移入回收暂存（.yonman\trash），<b>30 天内可还原</b>；彻底删除后将无法恢复。
            </p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

/* ---------- 文档类型卡片 ---------- */
function TypeCard({
  active, label, count, icon: Icon, fg, bg, onClick, onUpload,
}: {
  active: boolean; label: string; count: number;
  icon?: React.ElementType; fg?: string; bg?: string;
  onClick: () => void; onUpload: () => void;
}) {
  const I = Icon || Search;
  return (
    <button
      onClick={onClick}
      className={`group flex w-[132px] shrink-0 items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors ym-focus ${
        active ? "border-[#0969DA] bg-[#DDF4FF]" : "border-[#D1D9E0] bg-white hover:border-[#B7C0CC] hover:bg-[#F6F8FA]"
      }`}
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg || "bg-[#F6F8FA]"} ${fg || "text-[#59636E]"}`}>
        <I size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] font-medium ${active ? "text-[#1F2328]" : "text-[#1F2328]"}`}>{label}</span>
        <span className="block text-xs text-[#59636E]">{count} 份</span>
      </span>
      <span
        role="button"
        title={`上传到${label}`}
        className={`hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#59636E] hover:bg-white hover:text-[#0969DA] group-hover:flex ${active ? "" : ""}`}
        onClick={(e) => { e.stopPropagation(); onUpload(); }}
      >
        <Upload size={12} />
      </span>
    </button>
  );
}

/* ---------- 行内菜单项 ---------- */
function RowMenu({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={`flex w-full items-center px-3 py-1.5 text-left text-[13px] ${danger ? "text-[#CF222E] hover:bg-[#FFEBE9]" : "text-[#1F2328] hover:bg-[#F6F8FA]"}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ---------- 上传弹窗（含冲突策略） ---------- */
function UploadDialog({
  state, onClose, onChange, onConfirm, onPickMore,
}: {
  state: { files: File[]; targetType: DocType; existing: string[]; policies: Record<string, "replace" | "keep" | "skip"> };
  onClose: () => void;
  onChange: (s: any) => void;
  onConfirm: () => void;
  onPickMore: () => void;
}) {
  const { files, targetType, existing, policies } = state;
  const conflictSet = useMemo(() => new Set(files.map((f) => f.name).filter((n) => existing.includes(n))), [files, existing]);

  const setPolicy = (name: string, p: "replace" | "keep" | "skip") => onChange({ ...state, policies: { ...policies, [name]: p } });
  const applyAll = (p: "replace" | "keep" | "skip") => {
    const next = { ...policies };
    for (const n of conflictSet) next[n] = p;
    onChange({ ...state, policies: next });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`上传到「${DOC_TYPE_LABEL[targetType]}」`}
      width={560}
      footer={
        <>
          <OutlineButton onClick={onClose}>取消</OutlineButton>
          <PrimaryButton onClick={onConfirm}>上传 {files.length} 个文件</PrimaryButton>
        </>
      }
    >
      <div className="mb-3 flex items-center justify-between">
        <button className="text-xs text-[#0969DA] hover:underline" onClick={onPickMore}>+ 继续添加文件</button>
        {conflictSet.size > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-[#59636E]">
            全部应用：
            {([["replace", "替换"], ["keep", "保留两者"], ["skip", "跳过"]] as const).map(([k, label]) => (
              <button key={k} className="rounded border border-[#D1D9E0] px-1.5 py-0.5 hover:bg-[#F6F8FA] hover:text-[#0969DA]" onClick={() => applyAll(k)}>{label}</button>
            ))}
          </div>
        )}
      </div>
      <div className="max-h-[300px] space-y-2 overflow-y-auto pr-1 ym-scrollbar">
        {files.map((f, i) => {
          const conflict = conflictSet.has(f.name);
          const policy = policies[f.name] || "replace";
          return (
            <div key={`${f.name}-${i}`} className={`rounded-lg border px-3 py-2 ${conflict ? "border-[#FD8C73] bg-[#FFF8F5]" : "border-[#E7ECF0]"}`}>
              <div className="flex items-center gap-2 text-sm">
                <FileText size={14} className="shrink-0 text-[#59636E]" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-[#59636E]">{formatSize(f.size)}</span>
                <button className="text-xs text-[#59636E] hover:text-[#CF222E]" onClick={() => onChange({ ...state, files: files.filter((_, j) => j !== i) })}>移除</button>
              </div>
              {conflict && (
                <div className="mt-2 flex flex-wrap items-center gap-3 pl-6 text-xs">
                  <span className="text-[#9A6700]">同名文件已存在：</span>
                  {([["replace", "替换（旧版本自动归档）"], ["keep", "保留两者（自动加 (2) 后缀）"], ["skip", "跳过"]] as const).map(([k, label]) => (
                    <label key={k} className="flex cursor-pointer items-center gap-1">
                      <input type="radio" className="accent-[#0969DA]" checked={policy === k} onChange={() => setPolicy(f.name, k)} />
                      {label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-[#8b949e]">同名冲突默认「替换」，替换前的旧版本会自动归档到版本时间线，可随时还原。</p>
    </Modal>
  );
}

/* ---------- 版本时间线弹窗 ---------- */
function VersionsDialog({ pid, doc, onClose, onChanged }: { pid: string; doc: DocItem; onClose: () => void; onChanged: () => void }) {
  const [timeline, setTimeline] = useState<VersionItem[] | null>(null);
  const [previewVer, setPreviewVer] = useState<VersionItem | null>(null);
  const [restoreVer, setRestoreVer] = useState<VersionItem | null>(null);

  const loadVersions = useCallback(async () => {
    try {
      const r = await api.getVersions(pid, doc.id);
      setTimeline(r.timeline);
    } catch (e: any) {
      toast.error(e.message || "加载版本失败");
    }
  }, [pid, doc.id]);

  useEffect(() => { loadVersions(); }, [loadVersions]);

  const doRestore = async () => {
    if (!restoreVer) return;
    try {
      await api.restoreVersion(pid, doc.id, restoreVer.version);
      toast.success(`已还原到 v${restoreVer.version}，原版本已自动归档`);
      setRestoreVer(null);
      await loadVersions();
      onChanged();
    } catch (e: any) {
      toast.error(e.message || "还原失败");
    }
  };

  return (
    <>
      <Modal open onClose={onClose} title={`版本记录 — ${doc.file_name}`} width={560} footer={<><OutlineButton onClick={onClose}>关闭</OutlineButton></>}>
        {!timeline ? (
          <div className="py-10 text-center text-sm text-[#59636E]">加载中…</div>
        ) : (
          <div className="space-y-1">
            {timeline.map((v) => (
              <div key={v.version} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${v.is_current ? "border-[#0969DA] bg-[#DDF4FF]" : "border-[#E7ECF0]"}`}>
                <Tag color={v.is_current ? "blue" : "gray"}>v{v.version}</Tag>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-[#1F2328]">{VERSION_SOURCE_LABEL[v.source] || v.source}</div>
                  <div className="mt-0.5 truncate text-xs text-[#59636E]">
                    {v.stamp ? `${v.stamp.slice(0, 4)}-${v.stamp.slice(4, 6)}-${v.stamp.slice(6, 8)} ${v.stamp.slice(9, 11)}:${v.stamp.slice(11, 13)} · ` : ""}
                    {formatSize(v.size)} · {v.file_name}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <OutlineButton className="!h-7 !px-2.5 text-xs" onClick={() => setPreviewVer(v)}>预览</OutlineButton>
                  {!v.is_current && (
                    <OutlineButton className="!h-7 !px-2.5 text-xs" onClick={() => setRestoreVer(v)}>还原</OutlineButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-[#8b949e]">版本只增不减：替换、还原都会把当前内容自动归档，历史版本永久保留在工作区 .yonman\versions 目录。</p>
      </Modal>
      {previewVer && <PreviewDialog pid={pid} doc={doc} version={previewVer.version} onClose={() => setPreviewVer(null)} />}
      <ConfirmDialog
        open={!!restoreVer}
        onClose={() => setRestoreVer(null)}
        onConfirm={doRestore}
        title={`还原到 v${restoreVer?.version ?? ""}`}
        confirmText="还原"
      >
        还原后当前版本会自动归档为新版本，<b className="text-[#1F2328]">不会丢失任何历史内容</b>。
      </ConfirmDialog>
    </>
  );
}

/* ---------- 预览弹窗 ---------- */
const TEXT_EXT = [".txt", ".md", ".json", ".log", ".csv"];
const IMG_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function PreviewDialog({ pid, doc, version, onClose }: { pid: string; doc: DocItem; version?: number; onClose: () => void }) {
  const [content, setContent] = useState<{ kind: "text" | "img" | "pdf" | "bin"; data: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    (async () => {
      try {
        const res = version ? await api.previewVersion(pid, doc.id, version) : await api.getDocContent(pid, doc.id);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.message || `加载失败（${res.status}）`);
        }
        const blob = await res.blob();
        const name = version ? `v${version} 归档` : doc.file_name;
        const ext = doc.file_name.slice(doc.file_name.lastIndexOf(".")).toLowerCase();
        if (IMG_EXT.includes(ext)) {
          const url = URL.createObjectURL(blob);
          revoked = url;
          setContent({ kind: "img", data: url, name });
        } else if (ext === ".pdf") {
          const url = URL.createObjectURL(blob);
          revoked = url;
          setContent({ kind: "pdf", data: url, name });
        } else if (TEXT_EXT.includes(ext)) {
          setContent({ kind: "text", data: await blob.text(), name });
        } else {
          setContent({ kind: "bin", data: "", name });
        }
      } catch (e: any) {
        setError(e.message || "预览失败");
      }
    })();
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [pid, doc.id, doc.file_name, version]);

  return (
    <Modal open onClose={onClose} title={`预览 — ${content?.name || doc.file_name}`} width={640} footer={<><OutlineButton onClick={onClose}>关闭</OutlineButton></>}>
      {error && <div className="py-10 text-center text-sm text-[#CF222E]">{error}</div>}
      {!error && !content && <div className="py-10 text-center text-sm text-[#59636E]">加载中…</div>}
      {content?.kind === "text" && (
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg bg-[#F6F8FA] p-4 text-xs leading-5 text-[#1F2328] ym-scrollbar">{content.data || "（空文件）"}</pre>
      )}
      {content?.kind === "img" && <img src={content.data} alt={doc.file_name} className="max-h-[50vh] rounded-lg object-contain" />}
      {content?.kind === "pdf" && <iframe src={content.data} title={doc.file_name} className="h-[50vh] w-full rounded-lg border border-[#E7ECF0]" />}
      {content?.kind === "bin" && (
        <div className="py-8 text-center text-sm text-[#59636E]">该文件类型暂不支持在线预览，请下载后查看。</div>
      )}
    </Modal>
  );
}

/* ---------- 重命名文档 ---------- */
function RenameDocDialog({ pid, doc, onClose, onDone }: { pid: string; doc: DocItem | null; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);
  if (doc && doc.id !== lastId) {
    setLastId(doc.id);
    setValue(doc.file_name);
  }
  const submit = async () => {
    if (!doc) return;
    const name = value.trim();
    if (!name || name === doc.file_name) return onClose();
    if (/[<>:"/\\|?*]/.test(name)) return toast.error("文件名不能包含 <> : \" / \\ | ? * 字符");
    setBusy(true);
    try {
      await api.renameDoc(pid, doc.id, name);
      toast.success("已重命名");
      onDone();
    } catch (e: any) {
      toast.error(e.message || "重命名失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!doc} onClose={onClose} title="重命名文档" footer={<><OutlineButton onClick={onClose}>取消</OutlineButton><PrimaryButton onClick={submit} disabled={busy}>保存</PrimaryButton></>}>
      <YmInput autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      <p className="mt-2 text-xs text-[#8b949e]">仅修改文件名，版本历史保持不变；文件系统与登记记录会同步更新。</p>
    </Modal>
  );
}
