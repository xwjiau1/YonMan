/* YonMan MVP —— 页面控制器 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { api } from "@/lib/api";
import type { NodeItem, Workspace } from "@/lib/api";
import { Header } from "@/components/Header";
import type { MainTab } from "@/components/Header";
import { Welcome } from "@/components/Welcome";
import { TreePanel } from "@/components/TreePanel";
import { DocPanel } from "@/components/DocPanel";
import { TrashDialog } from "@/components/TrashDialog";
import { ChatPlaceholder } from "@/components/Placeholders";

const LS_LAST_WS = "ym.lastWorkspace";

export default function Home() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [tab, setTab] = useState<MainTab>("process");
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [ready, setReady] = useState(false);

  const loadWorkspaces = useCallback(async () => {
    try {
      const r = await api.listWorkspaces();
      setWorkspaces(r.items);
      return r.items;
    } catch (e: any) {
      toast.error(e.message || "加载项目列表失败");
      return [];
    }
  }, []);

  const refreshTree = useCallback(async (pid: string) => {
    try {
      const r = await api.getTree(pid);
      setNodes(r.nodes);
    } catch (e: any) {
      toast.error(e.message || "加载阶段树失败");
    }
  }, []);

  /* 初始化：恢复上次打开的工作区 */
  useEffect(() => {
    (async () => {
      const list = await loadWorkspaces();
      const lastId = localStorage.getItem(LS_LAST_WS);
      if (lastId) {
        const found = list.find((w) => w.id === lastId);
        if (found) {
          try {
            const r = await api.openWorkspace(found.id);
            setWs(r.project);
            await refreshTree(r.project.id);
          } catch { /* 忽略，留在欢迎页 */ }
        }
      }
      setReady(true);
    })();
  }, [loadWorkspaces, refreshTree]);

  const openWs = useCallback(async (w: Workspace) => {
    setWs(w);
    localStorage.setItem(LS_LAST_WS, w.id);
    setSelectedNodeId(null);
    setTab("process");
    await loadWorkspaces(); // 刷新最近列表顺序
    await refreshTree(w.id);
  }, [loadWorkspaces, refreshTree]);

  const backToWelcome = useCallback(async () => {
    setWs(null);
    setSelectedNodeId(null);
    await loadWorkspaces();
  }, [loadWorkspaces]);

  /* 选中节点的名称链与文件夹链 */
  const chain = useMemo(() => {
    if (!selectedNodeId) return { names: [] as string[], folders: [] as string[] };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let cur = byId.get(selectedNodeId);
    const names: string[] = [];
    const folders: string[] = [];
    while (cur) {
      names.unshift(cur.name);
      folders.unshift(cur.folder);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return { names, folders };
  }, [nodes, selectedNodeId]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F6F8FA] text-sm text-[#59636E]">
        <Toaster richColors position="top-center" />
        正在加载…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white">
      <Toaster richColors position="top-center" />
      {!ws ? (
        <Welcome workspaces={workspaces} onOpenWs={openWs} onCreated={openWs} />
      ) : (
        <>
          <Header
            ws={ws}
            workspaces={workspaces}
            onSwitchWs={openWs}
            tab={tab}
            onTabChange={setTab}
            onHome={backToWelcome}
          />
          <div className="flex min-h-0 flex-1">
            {tab === "process" ? (
              <>
                <TreePanel
                  ctx={{
                    pid: ws.id,
                    nodes,
                    selectedId: selectedNodeId,
                    onSelect: (id) => setSelectedNodeId(id || null),
                    onChanged: () => refreshTree(ws.id),
                    onOpenTrash: () => setTrashOpen(true),
                  }}
                />
                <DocPanel
                  pid={ws.id}
                  nodeId={selectedNodeId}
                  chainNames={chain.names}
                  chainFolders={chain.folders}
                  winPath={ws.win_path}
                  onDocsChanged={() => refreshTree(ws.id)}
                />
              </>
            ) : (
              <ChatPlaceholder />
            )}
          </div>
          <TrashDialog pid={ws.id} open={trashOpen} onClose={() => setTrashOpen(false)} onChanged={() => refreshTree(ws.id)} />
        </>
      )}
    </div>
  );
}
