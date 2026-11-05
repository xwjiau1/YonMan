/* 欢迎页 —— 最近打开 + 新建项目空间 */
import { Clock, FolderOpen, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, formatTime } from "@/lib/api";
import type { Workspace } from "@/lib/api";
import { electron } from "@/lib/electron";
import { Modal, OutlineButton, PrimaryButton, YmInput } from "./common";

export function Welcome({
  workspaces,
  onOpenWs,
  onCreated,
}: {
  workspaces: Workspace[];
  onOpenWs: (ws: Workspace) => void;
  onCreated: (ws: Workspace) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const open = async (w: Workspace) => {
    try {
      const r = await api.openWorkspace(w.id);
      onOpenWs(r.project);
    } catch (e: any) {
      toast.error(e.message || "打开失败");
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center bg-[#F6F8FA] px-6 py-14">
      <div className="mb-10 flex flex-col items-center">
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#0969DA] text-2xl font-bold text-white">Y</span>
        <h1 className="text-2xl font-semibold text-[#1F2328]">YonMan 智能项目管理工作台</h1>
        <p className="mt-2 text-sm text-[#59636E]">文件夹即真相 —— 以 Windows 文件系统为载体的项目过程资产管理</p>
      </div>

      <div className="w-full max-w-[720px] rounded-xl border border-[#D1D9E0] bg-white" style={{ boxShadow: "0 16px 32px rgba(140,149,159,0.15)" }}>
        <div className="flex items-center justify-between border-b border-[#D1D9E0] px-5 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#1F2328]">
            <Clock size={15} className="text-[#59636E]" /> 最近打开
            <span className="text-xs font-normal text-[#59636E]">（最多保留 10 个）</span>
          </div>
          <PrimaryButton onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> 新建项目空间
          </PrimaryButton>
        </div>

        {workspaces.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-[#D1D9E0] text-[#8b949e]">
              <FolderOpen size={24} />
            </div>
            <div className="text-sm font-medium text-[#1F2328]">还没有项目空间</div>
            <div className="text-xs text-[#59636E]">新建一个项目空间，开始在文件系统中沉淀项目过程资产</div>
            <PrimaryButton className="mt-2" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> 新建项目空间
            </PrimaryButton>
          </div>
        ) : (
          <ul className="divide-y divide-[#E7ECF0]">
            {workspaces.map((w) => (
              <li key={w.id}>
                <button
                  className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-[#F6F8FA]"
                  onClick={() => open(w)}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#DDF4FF] text-[#0969DA]">
                    <FolderKanbanIcon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[#1F2328]">{w.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-[#59636E]">{w.win_path}</span>
                  </span>
                  <span className="hidden shrink-0 text-xs text-[#59636E] sm:block">
                    {w.manager ? `负责人：${w.manager}` : ""}
                  </span>
                  <span className="hidden w-[130px] shrink-0 text-right text-xs text-[#59636E] md:block">
                    {formatTime(w.last_opened_at || w.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateWorkspaceModal open={createOpen} onClose={() => setCreateOpen(false)} busy={busy} setBusy={setBusy} onCreated={onCreated} />
    </div>
  );
}

function FolderKanbanIcon() {
  return <FolderOpen size={17} />;
}

function CreateWorkspaceModal({
  open,
  onClose,
  busy,
  setBusy,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCreated: (ws: Workspace) => void;
}) {
  const [form, setForm] = useState({ name: "", manager: "", customer: "", industry: "", product_line: "", path: "" });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const pickFolder = async () => {
    if (!electron) return;
    try {
      const p = await electron.selectFolder();
      if (p) set("path", p);
    } catch {
      toast.error("选择文件夹失败");
    }
  };

  const submit = async () => {
    if (!form.name.trim()) return toast.error("请填写项目名称");
    if (!form.manager.trim()) return toast.error("请填写项目负责人");
    setBusy(true);
    try {
      const base = {
        name: form.name.trim(),
        manager: form.manager.trim(),
        customer: form.customer.trim() || undefined,
        industry: form.industry.trim() || undefined,
        product_line: form.product_line.trim() || undefined,
      };
      const r = form.path.trim()
        ? await api.createLocalWorkspace({ ...base, path: form.path.trim() })
        : await api.createWorkspace(base);
      toast.success("项目空间已创建");
      onClose();
      onCreated(r.project);
    } catch (e: any) {
      toast.error(e.message || "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建项目空间"
      footer={
        <>
          <OutlineButton onClick={onClose}>取消</OutlineButton>
          <PrimaryButton onClick={submit} disabled={busy}>{busy ? "创建中…" : "创建"}</PrimaryButton>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="项目名称" required>
          <YmInput autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="例如：国新国际 ERP 实施" />
        </Field>
        <Field label="项目负责人" required>
          <YmInput value={form.manager} onChange={(e) => set("manager", e.target.value)} placeholder="姓名" />
        </Field>
        <Field label="客户名称">
          <YmInput value={form.customer} onChange={(e) => set("customer", e.target.value)} placeholder="可选" />
        </Field>
        <Field label="所属行业">
          <YmInput value={form.industry} onChange={(e) => set("industry", e.target.value)} placeholder="可选" />
        </Field>
        <Field label="产品线">
          <YmInput value={form.product_line} onChange={(e) => set("product_line", e.target.value)} placeholder="可选" />
        </Field>
        <Field label="工作区位置">
          <div className="flex gap-2">
            <YmInput
              value={form.path}
              onChange={(e) => set("path", e.target.value)}
              placeholder="留空=托管模式；或填写/选择真实文件夹路径"
            />
            {electron && (
              <OutlineButton className="shrink-0 !h-9" onClick={pickFolder}>选择文件夹</OutlineButton>
            )}
          </div>
        </Field>
        <p className="rounded-md bg-[#F6F8FA] px-3 py-2 text-xs leading-5 text-[#59636E]">
          留空则在数据目录下创建托管工作区（展示模拟 <code className="text-[#1F2328]">D:\项目名称_xxxxxx</code>
          ）；填写真实文件夹路径则直接落到本地磁盘（「文件夹即真相」）。自动生成 <code>.yonman</code>
          元数据与「蓝图阶段 / 实施阶段」默认结构，五大过程分区（会议纪要、工作日志、计划方案、交付物、其他）随阶段节点自动创建。
        </p>
      </div>
    </Modal>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[#59636E]">
        {label} {required && <span className="text-[#CF222E]">*</span>}
      </span>
      {children}
    </label>
  );
}
