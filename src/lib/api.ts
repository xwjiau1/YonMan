/* YonMan MVP — API 客户端与类型定义 */

export type DocType = "meeting" | "log" | "plan" | "deliverable" | "other";
export const DOC_TYPES: DocType[] = ["meeting", "log", "plan", "deliverable", "other"];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  meeting: "会议纪要",
  log: "工作日志",
  plan: "计划方案",
  deliverable: "交付物",
  other: "其他",
};

export interface Workspace {
  id: string;
  name: string;
  win_path: string;
  real_path: string;
  mode: "managed" | "local";
  manager: string;
  customer?: string;
  industry?: string;
  product_line?: string;
  created_at: string;
  updated_at?: string;
  last_opened_at?: string;
}

export interface NodeItem {
  id: string;
  parent_id: string | null;
  name: string;
  prefix: string;
  seq: number;
  folder: string;
  remark: string;
  doc_count: number;
  has_children: boolean;
}

export interface DocItem {
  id: string;
  node_id: string;
  doc_type: DocType;
  file_name: string;
  current_version: number;
  missing: boolean;
  size: number;
  real_path: string;
  mtime: string;
}

export interface DocsResponse {
  items: DocItem[];
  counts: Record<DocType, number>;
  node: { id: string; name: string; remark: string };
}

export interface VersionItem {
  version: number;
  stamp: string | null;
  size: number;
  source: string;
  file_name: string;
  is_current: boolean;
}

export interface VersionsResponse {
  doc: { id: string; file_name: string; current_version: number };
  timeline: VersionItem[];
}

export interface TrashItem {
  id: string;
  kind: "node" | "doc";
  name: string;
  original_path: string;
  deleted_at: string;
  expires_at: string;
  remaining_days: number;
}

export interface ScanSummary {
  registered: number;
  missing: number;
  recovered: number;
  loose_files: string[];
  unregistered_folders: string[];
  broken_nodes: string[];
}

export interface Features {
  chat: boolean;
  asset_library: boolean;
}

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || (body && body.ok === false)) {
    const code = body?.code || `HTTP_${res.status}`;
    const message = body?.message || body?.detail || `请求失败（${res.status}）`;
    throw new ApiError(typeof code === "string" ? code : "E_UNKNOWN", String(message));
  }
  return (body || {}) as T;
}

const json = (method: string, data?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: data === undefined ? undefined : JSON.stringify(data),
});

export const api = {
  health: () => req<{ ok: boolean }>("/api/health"),
  features: () => req<Features>("/api/features"),

  /* 工作区 */
  listWorkspaces: () => req<{ items: Workspace[] }>("/api/workspaces"),
  createWorkspace: (data: { name: string; manager?: string; customer?: string; industry?: string; product_line?: string }) =>
    req<{ project: Workspace }>("/api/workspaces", json("POST", data)),
  createLocalWorkspace: (data: { name: string; path: string; manager?: string; customer?: string; industry?: string; product_line?: string }) =>
    req<{ project: Workspace }>("/api/workspaces/local", json("POST", data)),
  getWorkspace: (pid: string) => req<{ project: Workspace }>(`/api/workspaces/${pid}`),
  openWorkspace: (pid: string) => req<{ project: Workspace }>(`/api/workspaces/${pid}/open`, json("POST")),
  updateWorkspace: (pid: string, data: Partial<Workspace>) =>
    req<{ project: Workspace }>(`/api/workspaces/${pid}`, json("PATCH", data)),

  /* 阶段树 */
  getTree: (pid: string) => req<{ nodes: NodeItem[] }>(`/api/workspaces/${pid}/tree`),
  createNode: (pid: string, data: { parent_id: string | null; name: string }) =>
    req<{ node: NodeItem }>(`/api/workspaces/${pid}/nodes`, json("POST", data)),
  renameNode: (pid: string, id: string, name: string) =>
    req<{ node: NodeItem }>(`/api/workspaces/${pid}/nodes/${id}`, json("PATCH", { name })),
  moveNode: (pid: string, id: string, parent_id: string | null, seq: number) =>
    req<{ node: NodeItem }>(`/api/workspaces/${pid}/nodes/${id}/move`, json("POST", { new_parent_id: parent_id, new_index: seq })),
  deleteNode: (pid: string, id: string) =>
    req<{ trash_id: string; doc_count: number }>(`/api/workspaces/${pid}/nodes/${id}`, { method: "DELETE" }),
  setRemark: (pid: string, id: string, remark: string) =>
    req<{ node: NodeItem }>(`/api/workspaces/${pid}/nodes/${id}/remark`, json("PUT", { remark })),
  nodeDocCount: (pid: string, id: string) =>
    req<{ count: number }>(`/api/workspaces/${pid}/nodes/${id}/doc-count`),

  /* 文档 */
  getDocs: (pid: string, nodeId: string) =>
    req<DocsResponse>(`/api/workspaces/${pid}/nodes/${nodeId}/docs`),
  uploadDocs: async (
    pid: string,
    nodeId: string,
    docType: DocType,
    files: File[],
    policies: Record<string, string>
  ) => {
    const fd = new FormData();
    fd.append("doc_type", docType);
    fd.append("policies", JSON.stringify(policies));
    for (const f of files) fd.append("files", f);
    return req<{ uploaded: { file_name: string; version: number; doc_id: string; replaced: boolean }[]; skipped: string[]; failed: { file_name: string; error: string }[] }>(
      `/api/workspaces/${pid}/nodes/${nodeId}/docs/upload`,
      { method: "POST", body: fd }
    );
  },
  downloadDoc: (pid: string, docId: string) => `/api/workspaces/${pid}/docs/${docId}/download`,
  /** 在线预览：返回原始 Response（按 Content-Type 区分文本/图片/PDF） */
  getDocContent: (pid: string, docId: string) => fetch(`/api/workspaces/${pid}/docs/${docId}/content`),
  renameDoc: (pid: string, docId: string, new_name: string) =>
    req<{}>(`/api/workspaces/${pid}/docs/${docId}/rename`, json("POST", { new_name })),
  deleteDoc: (pid: string, docId: string) =>
    req<{ trash_id: string }>(`/api/workspaces/${pid}/docs/${docId}`, { method: "DELETE" }),

  /* 版本 */
  getVersions: (pid: string, docId: string) =>
    req<VersionsResponse>(`/api/workspaces/${pid}/docs/${docId}/versions`),
  restoreVersion: (pid: string, docId: string, version: number) =>
    req<{ current_version: number }>(`/api/workspaces/${pid}/docs/${docId}/versions/${version}/restore`, json("POST")),
  previewVersion: (pid: string, docId: string, version: number) =>
    fetch(`/api/workspaces/${pid}/docs/${docId}/versions/${version}/preview`),

  /* 回收站 */
  getTrash: (pid: string) => req<{ items: TrashItem[] }>(`/api/workspaces/${pid}/trash`),
  restoreTrash: (pid: string, trashId: string) =>
    req<{ restored_to: string }>(`/api/workspaces/${pid}/trash/${trashId}/restore`, json("POST")),
  purgeTrash: (pid: string, trashId: string) =>
    req<{ purged: number }>(`/api/workspaces/${pid}/trash/${trashId}`, { method: "DELETE" }),
  emptyTrash: (pid: string) => req<{ purged: number }>(`/api/workspaces/${pid}/trash`, { method: "DELETE" }),

  /* 扫描 */
  scan: (pid: string) => req<{ summary: ScanSummary }>(`/api/workspaces/${pid}/scan`, json("POST")),
};

/* ---------- 工具 ---------- */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
