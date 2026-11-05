"""YonMan MVP 业务服务层：工作区 / 阶段树 / 文档 / 版本 / 回收暂存 / 刷新扫描。

设计原则（PRD 2.4）：
- 文件夹即真相：磁盘目录结构是唯一事实源，树与元数据可由目录重建；
- 元数据最小化：SQLite 仅存树、节点映射、版本记录等目录无法表达的信息，
  并同步写入工作区 .yonman/project.json（原子写，先写临时文件再替换）；
- 危险操作强确认：删除一律移入 .yonman/trash（保持原相对路径），30 天兜底；
- 所有写操作记录 .yonman/logs/operations.jsonl 审计日志。
"""

from __future__ import annotations

import json
import os
import random
import shutil
import string
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from .db import Database, now_iso
from .winfs import (
    DOC_TYPES,
    FsError,
    folder_name,
    new_id,
    next_prefix,
    sanitize_file_name,
    stamp_now,
    validate_node_name,
    win_join,
)

TRASH_RETENTION_DAYS = 30


# ---------------------------------------------------------------------------
# 路径与 project.json
# ---------------------------------------------------------------------------

def node_chain(db: Database, node) -> list:
    """自根至该节点的链路（用于拼磁盘路径与 Windows 展示路径）。"""
    chain = []
    cur = node
    while cur is not None:
        chain.append(cur)
        cur = db.one("SELECT * FROM nodes WHERE id = ?", (cur["parent_id"],)) if cur["parent_id"] else None
    return list(reversed(chain))


def node_dir(fs_root: str, chain: list) -> Path:
    p = Path(fs_root)
    for n in chain:
        p = p / n["folder"]
    return p


def node_win_path(project, chain: list) -> str:
    parts = [project["win_path"], *[n["folder"] for n in chain]]
    return win_join(*parts)


def _atomic_write_json(path: Path, data: dict) -> None:
    """原子写：先写临时文件再替换（PRD 6.4 防崩溃写坏）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def sync_project_json(db: Database, project_id: str) -> None:
    """把 DB 中的项目/节点/文档/回收登记同步到 .yonman/project.json。"""
    project = db.get_project(project_id)
    if not project:
        return
    nodes = db.query(
        "SELECT id, parent_id, name, prefix, seq, folder, remark, created_at "
        "FROM nodes WHERE project_id = ? AND deleted = 0 ORDER BY seq", (project_id,)
    )
    docs = db.query(
        "SELECT id, node_id, doc_type, file_name, current_version, missing, created_at "
        "FROM docs WHERE project_id = ? ORDER BY created_at", (project_id,)
    )
    trash = db.query(
        "SELECT id, kind, name, original_path, deleted_at, expires_at "
        "FROM trash WHERE project_id = ? ORDER BY deleted_at DESC", (project_id,)
    )
    payload = {
        "meta": {"schema": 1, "app": "yonman", "version": "0.1.0"},
        "project": {
            "id": project["id"], "name": project["name"], "path": project["win_path"],
            "manager": project["manager"], "customer": project["customer"],
            "industry": project["industry"], "product_line": project["product_line"],
            "created_at": project["created_at"],
        },
        "settings": {"rename_prefix_tip": True},
        "nodes": [dict(n) for n in nodes],
        "docs": [dict(d) for d in docs],
        "trash": [dict(t) for t in trash],
    }
    _atomic_write_json(Path(project["fs_root"]) / ".yonman" / "project.json", payload)


def append_op_log(db: Database, project_id: str, action: str, detail: dict) -> None:
    """审计日志：双写 SQLite 与工作区 .yonman/logs/operations.jsonl。"""
    db.log(project_id, action, detail)
    project = db.get_project(project_id)
    if not project:
        return
    log_dir = Path(project["fs_root"]) / ".yonman" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"ts": now_iso(), "action": action, "detail": detail}, ensure_ascii=False)
    with open(log_dir / "operations.jsonl", "a", encoding="utf-8") as f:
        f.write(line + "\n")


# ---------------------------------------------------------------------------
# 工作区
# ---------------------------------------------------------------------------

def _safe_dir_name(name: str) -> str:
    base = "".join(c for c in name if c not in '<>:"/\\|?*').strip().rstrip(". ")
    return (base or "workspace")[:40]


def _validate_workspace_name(name) -> str:
    name = (name or "").strip()
    if not name:
        raise FsError("E_INVALID_NAME", "项目名称不能为空")
    if len(name) > 30:
        raise FsError("E_INVALID_NAME", "项目名称不能超过 30 字")
    return name


def _bootstrap_workspace(db: Database, name: str, fs_root: Path, win_path: str,
                         mode: str, data) -> dict:
    """工作区落盘：建 .yonman 目录规范 + 初始两阶段树 + 同步 project.json + 审计日志。"""
    if fs_root.exists() and any(fs_root.iterdir()):
        raise FsError("E_IO", "目标目录非空，请选择空目录")
    fs_root.mkdir(parents=True, exist_ok=True)

    pid = new_id("ws")
    ts = now_iso()
    db.execute(
        "INSERT INTO projects (id, name, win_path, fs_root, mode, manager, customer, industry, "
        "product_line, created_at, updated_at, last_opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (pid, name, win_path, str(fs_root), mode, data.manager or "", data.customer or "",
         data.industry or "", data.product_line or "", ts, ts, ts),
    )

    # 目录规范：.yonman（project.json / versions / trash / logs）+ 初始两阶段树
    yonman = fs_root / ".yonman"
    for sub in (yonman, yonman / "versions", yonman / "trash", yonman / "logs"):
        sub.mkdir(parents=True, exist_ok=True)

    for i, stage in enumerate(("蓝图阶段", "实施阶段"), start=1):
        _create_node_record(db, pid, None, stage, i)
    sync_project_json(db, pid)
    append_op_log(db, pid, "workspace.create", {"name": name, "win_path": win_path, "mode": mode})
    return get_workspace(db, pid)


def create_workspace(db: Database, data) -> dict:
    """创建工作区（托管模式）：数据落在服务端 data/workspaces 下，对外展示模拟 D:\\ 路径。"""
    name = _validate_workspace_name(data.name)
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    fs_name = f"{_safe_dir_name(name)}_{suffix}"
    fs_root = db.data_dir / "workspaces" / fs_name
    win_path = f"D:\\{fs_name}"
    return _bootstrap_workspace(db, name, fs_root, win_path, "managed", data)


def create_local_workspace(db: Database, data) -> dict:
    """创建工作区（本地模式）：直接落在用户选中的真实 Windows 文件夹，文件夹即真相。"""
    name = _validate_workspace_name(data.name)
    raw_path = (getattr(data, "path", "") or "").strip()
    if not raw_path:
        raise FsError("E_INVALID_NAME", "请选择工作区文件夹")
    fs_root = Path(raw_path).expanduser()
    if not fs_root.is_absolute():
        raise FsError("E_INVALID_NAME", "工作区路径必须是绝对路径")
    return _bootstrap_workspace(db, name, fs_root, str(fs_root), "local", data)


def get_workspace(db: Database, project_id: str) -> dict:
    p = db.get_project(project_id)
    if not p:
        raise FsError("E_NOT_FOUND", "工作空间不存在")
    node_count = db.one("SELECT COUNT(*) c FROM nodes WHERE project_id = ? AND deleted = 0", (project_id,))["c"]
    doc_count = db.one("SELECT COUNT(*) c FROM docs WHERE project_id = ?", (project_id,))["c"]
    return {
        "id": p["id"], "name": p["name"], "win_path": p["win_path"],
        "real_path": p["fs_root"],
        "mode": p["mode"],
        "manager": p["manager"], "customer": p["customer"], "industry": p["industry"],
        "product_line": p["product_line"], "created_at": p["created_at"],
        "last_opened_at": p["last_opened_at"],
        "counts": {"nodes": node_count, "docs": doc_count},
    }


def list_workspaces(db: Database) -> list[dict]:
    """最近工作区列表（上限 10 个，PRD 5.1）。"""
    return [get_workspace(db, r["id"]) for r in db.recent_projects(10)]


def open_workspace(db: Database, project_id: str) -> dict:
    """打开工作区：更新最近时间，启动时自动清理过期回收暂存（PRD 5.5/6.3）。"""
    p = db.get_project(project_id)
    if not p:
        raise FsError("E_NOT_FOUND", "工作空间不存在或路径不可访问")
    if not Path(p["fs_root"]).exists():
        raise FsError("E_NOT_FOUND", "工作区路径不可访问（可能磁盘未挂载或文件夹被移动）")
    db.execute("UPDATE projects SET last_opened_at = ? WHERE id = ?", (now_iso(), project_id))
    purged = purge_expired_trash(db, project_id)
    result = get_workspace(db, project_id)
    result["tree"] = list_tree(db, project_id)
    result["purged_trash"] = purged
    return result


def update_workspace(db: Database, project_id: str, data) -> dict:
    p = db.get_project(project_id)
    if not p:
        raise FsError("E_NOT_FOUND", "工作空间不存在")
    fields = {
        "name": getattr(data, "name", None) or p["name"],
        "manager": getattr(data, "manager", None) if getattr(data, "manager", None) is not None else p["manager"],
        "customer": getattr(data, "customer", None) if getattr(data, "customer", None) is not None else p["customer"],
        "industry": getattr(data, "industry", None) if getattr(data, "industry", None) is not None else p["industry"],
        "product_line": getattr(data, "product_line", None) if getattr(data, "product_line", None) is not None else p["product_line"],
    }
    db.execute(
        "UPDATE projects SET name=?, manager=?, customer=?, industry=?, product_line=?, updated_at=? WHERE id=?",
        (fields["name"], fields["manager"], fields["customer"], fields["industry"],
         fields["product_line"], now_iso(), project_id),
    )
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "workspace.update", fields)
    return get_workspace(db, project_id)


# ---------------------------------------------------------------------------
# 阶段-事项树
# ---------------------------------------------------------------------------

def _create_node_record(db: Database, project_id: str, parent_id: str | None,
                        name: str, seq: int, remark: str = "") -> str:
    """建节点 = 建文件夹 + 五类分区（PRD 3.3 约定 2），返回节点 ID。"""
    name = validate_node_name(name)
    prefix = next_prefix(seq)
    folder = folder_name(prefix, name)
    project = db.get_project(project_id)
    parent = db.one("SELECT * FROM nodes WHERE id = ? AND deleted = 0", (parent_id,)) if parent_id else None
    if parent_id and not parent:
        raise FsError("E_NOT_FOUND", "父节点不存在")
    chain = node_chain(db, parent) if parent else []
    parent_dir = node_dir(project["fs_root"], chain)
    target = parent_dir / folder
    if target.exists():
        raise FsError("E_DUP", f"同级已存在名为「{name}」的阶段")
    node_id = new_id("n")
    # 同级唯一性校验（名称）
    dup = db.one(
        "SELECT 1 FROM nodes WHERE project_id=? AND parent_id IS ? AND deleted=0 AND name=?",
        (project_id, parent_id, name),
    )
    if dup:
        raise FsError("E_DUP", f"同级已存在名为「{name}」的阶段")
    target.mkdir(parents=True)
    for t in DOC_TYPES:
        (target / t).mkdir()
    db.execute(
        "INSERT INTO nodes (id, project_id, parent_id, name, prefix, seq, folder, remark, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (node_id, project_id, parent_id, name, prefix, seq, folder, remark, now_iso()),
    )
    return node_id


def list_tree(db: Database, project_id: str) -> list[dict]:
    """读树（含每节点递归文档总数，PRD 6.1）。"""
    nodes = db.query(
        "SELECT * FROM nodes WHERE project_id = ? AND deleted = 0 ORDER BY seq", (project_id,)
    )
    docs = db.query("SELECT node_id FROM docs WHERE project_id = ?", (project_id,))
    count_map: dict[str, int] = {}
    for d in docs:
        count_map[d["node_id"]] = count_map.get(d["node_id"], 0) + 1
    children_map: dict[str | None, list] = {}
    for n in nodes:
        children_map.setdefault(n["parent_id"], []).append(n)

    def recursive_count(node_id: str) -> int:
        total = count_map.get(node_id, 0)
        for c in children_map.get(node_id, []):
            total += recursive_count(c["id"])
        return total

    return [
        {
            "id": n["id"], "parent_id": n["parent_id"], "name": n["name"],
            "prefix": n["prefix"], "seq": n["seq"], "folder": n["folder"],
            "remark": n["remark"], "doc_count": recursive_count(n["id"]),
            "has_children": bool(children_map.get(n["id"])),
        }
        for n in nodes
    ]


def get_node(db: Database, project_id: str, node_id: str):
    n = db.one("SELECT * FROM nodes WHERE id = ? AND project_id = ? AND deleted = 0", (node_id, project_id))
    if not n:
        raise FsError("E_NOT_FOUND", "节点不存在")
    return n


def add_node(db: Database, project_id: str, parent_id: str | None, name: str) -> dict:
    name = validate_node_name(name)
    siblings = db.query(
        "SELECT COALESCE(MAX(seq), 0) m FROM nodes WHERE project_id=? AND parent_id IS ? AND deleted=0",
        (project_id, parent_id),
    )
    seq = siblings[0]["m"] + 1
    node_id = _create_node_record(db, project_id, parent_id, name, seq)
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "node.add", {"node_id": node_id, "parent_id": parent_id, "name": name})
    return {"id": node_id, "name": name, "seq": seq}


def rename_node(db: Database, project_id: str, node_id: str, new_name: str) -> None:
    node = get_node(db, project_id, node_id)
    new_name = validate_node_name(new_name)
    dup = db.one(
        "SELECT 1 FROM nodes WHERE project_id=? AND parent_id IS ? AND deleted=0 AND name=? AND id<>?",
        (project_id, node["parent_id"], new_name, node_id),
    )
    if dup:
        raise FsError("E_DUP", f"同级已存在名为「{new_name}」的阶段")
    project = db.get_project(project_id)
    chain = node_chain(db, node)
    old_dir = node_dir(project["fs_root"], chain)
    new_folder = folder_name(node["prefix"], new_name)
    new_dir = old_dir.parent / new_folder
    try:
        os.rename(old_dir, new_dir)
    except OSError as e:
        raise FsError("E_BUSY", "文件夹被占用，请关闭相关程序后重试") from e
    db.execute("UPDATE nodes SET name=?, folder=? WHERE id=?", (new_name, new_folder, node_id))
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "node.rename", {"node_id": node_id, "from": node["name"], "to": new_name})


def set_node_remark(db: Database, project_id: str, node_id: str, remark: str) -> None:
    get_node(db, project_id, node_id)
    db.execute("UPDATE nodes SET remark=? WHERE id=?", (remark or "", node_id))
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "node.remark", {"node_id": node_id})


def _resequence(db: Database, project_id: str, parent_id: str | None) -> None:
    """同级拖拽排序后按 seq 重排序号前缀（PRD 6.2：01/02/03 自动重排）。"""
    siblings = db.query(
        "SELECT * FROM nodes WHERE project_id=? AND parent_id IS ? AND deleted=0 ORDER BY seq, created_at",
        (project_id, parent_id),
    )
    project = db.get_project(project_id)
    parent = db.one("SELECT * FROM nodes WHERE id=?", (parent_id,)) if parent_id else None
    chain = node_chain(db, parent) if parent else []
    base = node_dir(project["fs_root"], chain)
    for i, s in enumerate(siblings, start=1):
        if s["seq"] != i or s["prefix"] != next_prefix(i):
            new_folder = folder_name(next_prefix(i), s["name"])
            old = base / s["folder"]
            new = base / new_folder
            if old != new and old.exists():
                os.rename(old, new)
            db.execute("UPDATE nodes SET seq=?, prefix=?, folder=? WHERE id=?",
                       (i, next_prefix(i), new_folder, s["id"]))


def move_node(db: Database, project_id: str, node_id: str,
              new_parent_id: str | None, new_index: int) -> None:
    """跨父级移动节点：禁止拖入自身子孙，磁盘物理移动（PRD 6.2）。"""
    node = get_node(db, project_id, node_id)
    if new_parent_id == node_id:
        raise FsError("E_INVALID_NAME", "不能移动到自身")
    # 校验目标父级不是该节点的子孙
    cur = db.one("SELECT * FROM nodes WHERE id=? AND deleted=0", (new_parent_id,)) if new_parent_id else None
    while cur is not None:
        if cur["id"] == node_id:
            raise FsError("E_INVALID_NAME", "不能移动到自身或其子阶段下")
        cur = db.one("SELECT * FROM nodes WHERE id=? AND deleted=0", (cur["parent_id"],)) if cur["parent_id"] else None

    project = db.get_project(project_id)
    old_parent_id = node["parent_id"]
    chain = node_chain(db, node)
    old_dir = node_dir(project["fs_root"], chain)

    # 先在 DB 中调整父子关系与序号，再统一重排两边序号前缀
    db.execute("UPDATE nodes SET parent_id=? WHERE id=?", (new_parent_id, node_id))
    siblings = db.query(
        "SELECT id FROM nodes WHERE project_id=? AND parent_id IS ? AND deleted=0 AND id<>? ORDER BY seq",
        (project_id, new_parent_id, node_id),
    )
    order = [s["id"] for s in siblings]
    idx = max(0, min(new_index, len(order)))
    order.insert(idx, node_id)
    for i, nid in enumerate(order, start=1):
        db.execute("UPDATE nodes SET seq=? WHERE id=?", (i, nid))

    # 物理移动文件夹（使用重排后的新前缀命名）
    new_parent = db.one("SELECT * FROM nodes WHERE id=?", (new_parent_id,)) if new_parent_id else None
    new_chain = node_chain(db, new_parent) if new_parent else []
    target_dir = node_dir(project["fs_root"], new_chain)
    target_dir.mkdir(parents=True, exist_ok=True)
    # _resequence 会按新 parent 重算前缀并重命名文件夹
    _resequence(db, project_id, new_parent_id)
    node = db.one("SELECT * FROM nodes WHERE id=?", (node_id,))
    moved_target = target_dir / node["folder"]
    if old_dir.exists() and old_dir != moved_target:
        try:
            shutil.move(str(old_dir), str(moved_target))
        except OSError as e:
            raise FsError("E_BUSY", "文件夹被占用，请关闭相关程序后重试") from e
    if old_parent_id != new_parent_id:
        _resequence(db, project_id, old_parent_id)
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "node.move", {"node_id": node_id, "new_parent_id": new_parent_id})


def _node_doc_count(db: Database, project_id: str, node_id: str) -> int:
    total = db.one("SELECT COUNT(*) c FROM docs WHERE node_id=?", (node_id,))["c"]
    for c in db.query("SELECT id FROM nodes WHERE parent_id=? AND deleted=0", (node_id,)):
        total += _node_doc_count(db, project_id, c["id"])
    return total


def node_recursive_doc_count(db: Database, project_id: str, node_id: str) -> int:
    return _node_doc_count(db, project_id, node_id)


def delete_node(db: Database, project_id: str, node_id: str) -> dict:
    """删除节点（强确认由前端完成）：整树移入 .yonman/trash，保持相对结构。"""
    node = get_node(db, project_id, node_id)
    count = node_recursive_doc_count(db, project_id, node_id)
    project = db.get_project(project_id)
    chain = node_chain(db, node)
    src_dir = node_dir(project["fs_root"], chain)
    rel_path = win_join(*[n["folder"] for n in chain])
    trash_id = _new_trash_id()
    trash_dir = Path(project["fs_root"]) / ".yonman" / "trash" / trash_id
    trash_dir.mkdir(parents=True, exist_ok=True)
    if src_dir.exists():
        shutil.move(str(src_dir), str(trash_dir / chain[-1]["folder"]))
    db.execute("UPDATE nodes SET deleted=1 WHERE id=?", (node_id,))
    deleted_at = now_iso()
    expires_at = (datetime.now() + timedelta(days=TRASH_RETENTION_DAYS)).isoformat(timespec="seconds")
    db.execute(
        "INSERT INTO trash (id, project_id, kind, name, original_path, original_ref, deleted_at, expires_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (trash_id, project_id, "node", node["name"], rel_path,
         json.dumps({"node_id": node_id}, ensure_ascii=False), deleted_at, expires_at),
    )
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "node.delete", {"node_id": node_id, "name": node["name"], "doc_count": count})
    return {"trash_id": trash_id, "doc_count": count}


def _new_trash_id() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + "".join(
        random.choices(string.ascii_lowercase + string.digits, k=4))


# ---------------------------------------------------------------------------
# 节点文档区
# ---------------------------------------------------------------------------

def _doc_fs_path(db: Database, project_id: str, doc) -> Path:
    node = db.one("SELECT * FROM nodes WHERE id=?", (doc["node_id"],))
    chain = node_chain(db, node) if node else []
    project = db.get_project(project_id)
    return node_dir(project["fs_root"], chain) / doc["doc_type"] / doc["file_name"]


def list_docs(db: Database, project_id: str, node_id: str,
              doc_type: str | None = None) -> dict:
    """列出节点文档（含版本号、缺失标记），并返回五类分区各自计数。"""
    node = get_node(db, project_id, node_id)
    sql = "SELECT * FROM docs WHERE node_id=?"
    args: list = [node_id]
    if doc_type:
        sql += " AND doc_type=?"
        args.append(doc_type)
    sql += " ORDER BY file_name"
    rows = db.query(sql, tuple(args))
    counts = {t: 0 for t in DOC_TYPES}
    for c in db.query("SELECT doc_type, COUNT(*) c FROM docs WHERE node_id=? GROUP BY doc_type", (node_id,)):
        counts[c["doc_type"]] = c["c"]
    items = []
    for d in rows:
        p = _doc_fs_path(db, project_id, d)
        try:
            st = p.stat()
            size, mtime, missing = st.st_size, st.st_mtime, False
        except OSError:
            size, mtime, missing = 0, 0, True
        if missing != bool(d["missing"]):
            db.execute("UPDATE docs SET missing=? WHERE id=?", (1 if missing else 0, d["id"]))
        items.append({
            "id": d["id"], "node_id": d["node_id"], "doc_type": d["doc_type"],
            "file_name": d["file_name"], "current_version": d["current_version"],
            "missing": missing, "size": size,
            "real_path": str(p),
            "mtime": datetime.fromtimestamp(mtime).isoformat(timespec="seconds") if mtime else None,
        })
    return {"items": items, "counts": counts, "node": {"id": node["id"], "name": node["name"], "remark": node["remark"]}}


def get_doc(db: Database, project_id: str, doc_id: str):
    d = db.one("SELECT * FROM docs WHERE id=? AND project_id=?", (doc_id, project_id))
    if not d:
        raise FsError("E_NOT_FOUND", "文档不存在")
    return d


def _archive_version(db: Database, project_id: str, doc, source: str) -> None:
    """append-only 归档：当前文件复制到 .yonman/versions/{doc_id}/{stamp}_{文件名}。"""
    src = _doc_fs_path(db, project_id, doc)
    if not src.exists():
        return
    project = db.get_project(project_id)
    versions_dir = Path(project["fs_root"]) / ".yonman" / "versions" / doc["id"]
    versions_dir.mkdir(parents=True, exist_ok=True)
    stamp = stamp_now()
    name = f"{stamp}_{doc['file_name']}"
    target = versions_dir / name
    while target.exists():  # 同秒多版本防冲突
        name = f"{stamp}_{random.randint(100, 999)}_{doc['file_name']}"
        target = versions_dir / name
    shutil.copy2(src, target)
    # 归档记录的是「被归档内容所属的版本号」（append-only），当前版本由调用方 +1
    v = doc["current_version"]
    db.execute(
        "INSERT INTO doc_versions (doc_id, version, stamp, size, source, file_name, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (doc["id"], v, stamp, src.stat().st_size, source, name, now_iso()),
    )


def upload_docs(db: Database, project_id: str, node_id: str, doc_type: str,
                files: list, policies: dict) -> dict:
    """上传文件到节点指定分区。

    policies: {原始文件名: 'replace'|'keep'|'skip'} —— 同名冲突三选一
    （替换=旧版本自动归档；保留两者=自动加 (2) 后缀；跳过）。
    多文件队列失败汇总，不中断队列（MVP 5.3）。
    """
    if doc_type not in DOC_TYPES:
        raise FsError("E_INVALID_NAME", "未知文档类型")
    node = get_node(db, project_id, node_id)
    project = db.get_project(project_id)
    chain = node_chain(db, node)
    partition = node_dir(project["fs_root"], chain) / doc_type
    partition.mkdir(parents=True, exist_ok=True)

    uploaded, skipped, failed = [], [], []
    for f in files:
        try:
            raw_name = os.path.basename(f.filename or "未命名")
            final_name = sanitize_file_name(raw_name)
            policy = policies.get(raw_name) or policies.get(final_name) or "replace"
            existing = db.one(
                "SELECT * FROM docs WHERE node_id=? AND doc_type=? AND file_name=?",
                (node_id, doc_type, final_name),
            )
            target = partition / final_name
            if existing and policy == "skip":
                skipped.append(final_name)
                continue
            if existing and policy == "keep":
                final_name = _free_name(partition, final_name)
                target = partition / final_name
                existing = None
            # 先写临时文件，成功后再处理版本，避免半个版本（MVP 场景 6）
            fd, tmp = tempfile.mkstemp(dir=str(partition), suffix=".upload")
            try:
                with os.fdopen(fd, "wb") as out:
                    shutil.copyfileobj(f.file, out)
            except Exception:
                os.unlink(tmp)
                raise
            if existing:
                _archive_version(db, project_id, existing, "replace")
                os.replace(tmp, target)
                db.execute("UPDATE docs SET current_version=current_version+1, updated_at=? WHERE id=?",
                           (now_iso(), existing["id"]))
                uploaded.append({"file_name": final_name, "version": existing["current_version"] + 1,
                                 "doc_id": existing["id"], "replaced": True})
            else:
                os.replace(tmp, target)
                doc_id = new_id("d")
                db.execute(
                    "INSERT INTO docs (id, project_id, node_id, doc_type, file_name, current_version, "
                    "missing, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)",
                    (doc_id, project_id, node_id, doc_type, final_name, now_iso(), now_iso()),
                )
                uploaded.append({"file_name": final_name, "version": 1, "doc_id": doc_id, "replaced": False})
        except Exception as e:  # noqa: BLE001 - 失败汇总不中断
            failed.append({"file_name": f.filename, "error": str(e)})
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "docs.upload",
                  {"node_id": node_id, "doc_type": doc_type, "files": [u["file_name"] for u in uploaded]})
    return {"uploaded": uploaded, "skipped": skipped, "failed": failed}


def _free_name(partition: Path, name: str) -> str:
    """同名冲突「保留两者」：自动加 (2)、(3)… 后缀（MVP 5.3）。"""
    stem, dot, ext = name.rpartition(".")
    if not dot or stem == "":
        stem, ext = name, ""
        dot = ""
    for i in range(2, 1000):
        candidate = f"{stem}({i}){'.' + ext if dot else ''}"
        if not (partition / candidate).exists():
            return candidate
    raise FsError("E_IO", "无法生成不冲突的文件名")


def rename_doc(db: Database, project_id: str, doc_id: str, new_name: str) -> None:
    doc = get_doc(db, project_id, doc_id)
    new_name = sanitize_file_name(os.path.basename(new_name or ""))
    if not new_name:
        raise FsError("E_INVALID_NAME", "文件名不能为空")
    dup = db.one(
        "SELECT 1 FROM docs WHERE node_id=? AND doc_type=? AND file_name=? AND id<>?",
        (doc["node_id"], doc["doc_type"], new_name, doc_id),
    )
    if dup:
        raise FsError("E_DUP", f"已存在同名文件「{new_name}」")
    old = _doc_fs_path(db, project_id, doc)
    new = old.parent / new_name
    try:
        os.rename(old, new)
    except OSError as e:
        raise FsError("E_BUSY", "文件被占用，请关闭相关程序后重试") from e
    db.execute("UPDATE docs SET file_name=?, updated_at=? WHERE id=?", (new_name, now_iso(), doc_id))
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "doc.rename", {"doc_id": doc_id, "from": doc["file_name"], "to": new_name})


def delete_doc(db: Database, project_id: str, doc_id: str) -> dict:
    """删除文档：移入回收暂存，列表即时消失（MVP 5.3/5.5）。"""
    doc = get_doc(db, project_id, doc_id)
    node = db.one("SELECT * FROM nodes WHERE id=?", (doc["node_id"],))
    chain = node_chain(db, node)
    rel_path = win_join(*[n["folder"] for n in chain], doc["doc_type"], doc["file_name"])
    project = db.get_project(project_id)
    trash_id = _new_trash_id()
    trash_dir = Path(project["fs_root"]) / ".yonman" / "trash" / trash_id
    trash_dir.mkdir(parents=True, exist_ok=True)
    src = _doc_fs_path(db, project_id, doc)
    if src.exists():
        shutil.move(str(src), str(trash_dir / doc["file_name"]))
    db.execute("DELETE FROM docs WHERE id=?", (doc_id,))
    deleted_at = now_iso()
    expires_at = (datetime.now() + timedelta(days=TRASH_RETENTION_DAYS)).isoformat(timespec="seconds")
    db.execute(
        "INSERT INTO trash (id, project_id, kind, name, original_path, original_ref, deleted_at, expires_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (trash_id, project_id, "doc", doc["file_name"], rel_path,
         json.dumps({"doc_id": doc_id, "node_id": doc["node_id"], "doc_type": doc["doc_type"],
                     "file_name": doc["file_name"], "current_version": doc["current_version"],
                     "created_at": doc["created_at"]}, ensure_ascii=False),
         deleted_at, expires_at),
    )
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "doc.delete", {"doc_id": doc_id, "file_name": doc["file_name"]})
    return {"trash_id": trash_id}


# ---------------------------------------------------------------------------
# 版本管理（append-only 归档，MVP 5.4）
# ---------------------------------------------------------------------------

def list_versions(db: Database, project_id: str, doc_id: str) -> dict:
    doc = get_doc(db, project_id, doc_id)
    rows = db.query("SELECT * FROM doc_versions WHERE doc_id=? ORDER BY version DESC", (doc_id,))
    p = _doc_fs_path(db, project_id, doc)
    size = p.stat().st_size if p.exists() else 0
    timeline = [{
        "version": doc["current_version"], "stamp": None, "size": size,
        "source": "current", "file_name": doc["file_name"], "is_current": True,
    }]
    for r in rows:
        timeline.append({"version": r["version"], "stamp": r["stamp"], "size": r["size"],
                         "source": r["source"], "file_name": r["file_name"], "is_current": False})
    return {"doc": {"id": doc["id"], "file_name": doc["file_name"],
                    "current_version": doc["current_version"]}, "timeline": timeline}


def _version_archive_path(db: Database, project_id: str, doc_id: str,
                          version: int) -> Path:
    project = db.get_project(project_id)
    row = db.one("SELECT * FROM doc_versions WHERE doc_id=? AND version=?", (doc_id, version))
    if not row:
        raise FsError("E_NOT_FOUND", f"版本 v{version} 不存在")
    return Path(project["fs_root"]) / ".yonman" / "versions" / doc_id / row["file_name"]


def restore_version(db: Database, project_id: str, doc_id: str, version: int) -> dict:
    """还原到历史版本：当前版本先归档为 v{N+1}，再覆盖为历史版本内容。"""
    doc = get_doc(db, project_id, doc_id)
    archive = _version_archive_path(db, project_id, doc_id, version)
    if not archive.exists():
        raise FsError("E_NOT_FOUND", f"版本 v{version} 的归档文件缺失")
    _archive_version(db, project_id, doc, "restore-prev")
    target = _doc_fs_path(db, project_id, doc)
    shutil.copy2(archive, target)
    db.execute("UPDATE docs SET current_version=current_version+1, updated_at=? WHERE id=?",
               (now_iso(), doc_id))
    new_version = doc["current_version"] + 1
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "doc.version.restore",
                  {"doc_id": doc_id, "version": version, "now_current": new_version})
    return {"current_version": new_version}


def preview_version(db: Database, project_id: str, doc_id: str, version: int) -> Path:
    get_doc(db, project_id, doc_id)
    if version == get_doc(db, project_id, doc_id)["current_version"]:
        return _doc_fs_path(db, project_id, get_doc(db, project_id, doc_id))
    return _version_archive_path(db, project_id, doc_id, version)


# ---------------------------------------------------------------------------
# 回收暂存（.yonman/trash，30 天兜底，MVP 5.5）
# ---------------------------------------------------------------------------

def _remaining_days(expires_at: str) -> int:
    exp = datetime.fromisoformat(expires_at)
    return max(0, (exp - datetime.now()).days)


def list_trash(db: Database, project_id: str) -> list[dict]:
    rows = db.query("SELECT * FROM trash WHERE project_id=? ORDER BY deleted_at DESC", (project_id,))
    return [{
        "id": r["id"], "kind": r["kind"], "name": r["name"],
        "original_path": r["original_path"], "deleted_at": r["deleted_at"],
        "expires_at": r["expires_at"], "remaining_days": _remaining_days(r["expires_at"]),
    } for r in rows]


def _trash_dir(project, trash_id: str) -> Path:
    return Path(project["fs_root"]) / ".yonman" / "trash" / trash_id


def _purge_trash_item(db: Database, project, item) -> None:
    """彻底删除：物理删除暂存内容及其版本归档（回收站内二次手动执行，PRD 6.3）。"""
    td = _trash_dir(project, item["id"])
    if item["kind"] == "node":
        ref = json.loads(item["original_ref"] or "{}")
        node_id = ref.get("node_id")
        if node_id:
            for d in db.query("SELECT id FROM docs WHERE node_id=?", (node_id,)):
                _purge_doc_archives(db, project, d["id"])
                db.execute("DELETE FROM docs WHERE id=?", (d["id"],))
            descendant_ids = [node_id]
            queue = [node_id]
            while queue:
                cur = queue.pop()
                for c in db.query("SELECT id FROM nodes WHERE parent_id=?", (cur,)):
                    queue.append(c["id"])
                    descendant_ids.append(c["id"])
            for nid in descendant_ids:
                db.execute("DELETE FROM nodes WHERE id=?", (nid,))
        if td.exists():
            shutil.rmtree(td, ignore_errors=True)
    else:
        ref = json.loads(item["original_ref"] or "{}")
        if ref.get("doc_id"):
            _purge_doc_archives(db, project, ref["doc_id"])
        if td.exists():
            shutil.rmtree(td, ignore_errors=True)
    db.execute("DELETE FROM trash WHERE id=?", (item["id"],))


def _purge_doc_archives(db: Database, project, doc_id: str) -> None:
    vdir = Path(project["fs_root"]) / ".yonman" / "versions" / doc_id
    if vdir.exists():
        shutil.rmtree(vdir, ignore_errors=True)
    db.execute("DELETE FROM doc_versions WHERE doc_id=?", (doc_id,))


def purge_trash(db: Database, project_id: str, trash_id: str | None = None) -> dict:
    project = db.get_project(project_id)
    if not project:
        raise FsError("E_NOT_FOUND", "工作空间不存在")
    if trash_id:
        item = db.one("SELECT * FROM trash WHERE id=? AND project_id=?", (trash_id, project_id))
        if not item:
            raise FsError("E_NOT_FOUND", "回收站条目不存在")
        _purge_trash_item(db, project, item)
        count = 1
    else:
        items = db.query("SELECT * FROM trash WHERE project_id=?", (project_id,))
        for item in items:
            _purge_trash_item(db, project, item)
        count = len(items)
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "trash.purge", {"trash_id": trash_id, "count": count})
    return {"purged": count}


def restore_trash(db: Database, project_id: str, trash_id: str) -> dict:
    """从回收暂存还原：保持原相对路径；原位置已存在同名时自动改名 (还原) 后缀。"""
    project = db.get_project(project_id)
    item = db.one("SELECT * FROM trash WHERE id=? AND project_id=?", (trash_id, project_id))
    if not item:
        raise FsError("E_NOT_FOUND", "回收站条目不存在")
    td = _trash_dir(project, trash_id)
    ref = json.loads(item["original_ref"] or "{}")
    restored_to = item["original_path"]
    if item["kind"] == "node":
        node_id = ref.get("node_id")
        node = db.one("SELECT * FROM nodes WHERE id=?", (node_id,))
        if not node:
            raise FsError("E_NOT_FOUND", "节点记录缺失，无法还原")
        # 原位置（按原始相对路径还原；父级不存在则还原到最近可用父级，MVP 场景 12）
        dest = Path(project["fs_root"])
        parts = item["original_path"].split("\\")
        for part in parts[:-1]:
            dest = dest / part
        if not dest.exists():
            dest = Path(project["fs_root"])
            restored_to = parts[-1]
        target = dest / parts[-1]
        if target.exists():  # 冲突自动改名
            stem = target
            i = 2
            while target.exists():
                target = dest / f"{stem.name}(还原{i - 1})"
                i += 1
            restored_to = win_join(*([str(dest.relative_to(project["fs_root"]))] if dest != Path(project["fs_root"]) else []), target.name)
        if td.exists():
            src = td / parts[-1]
            shutil.move(str(src), str(target))
            shutil.rmtree(td, ignore_errors=True)
        db.execute("UPDATE nodes SET deleted=0 WHERE id=?", (node_id,))
    else:
        node_id = ref.get("node_id")
        node = db.one("SELECT * FROM nodes WHERE id=? AND deleted=0", (node_id,))
        if not node:
            raise FsError("E_NOT_FOUND", "原节点已不存在，无法还原")
        chain = node_chain(db, node)
        partition = node_dir(project["fs_root"], chain) / ref["doc_type"]
        partition.mkdir(parents=True, exist_ok=True)
        file_name = ref["file_name"]
        target = partition / file_name
        doc_id = ref.get("doc_id") or new_id("d")
        if db.one("SELECT 1 FROM docs WHERE id=?", (doc_id,)) or target.exists():
            stem, dot, ext = file_name.rpartition(".")
            i = 2
            while target.exists():
                if dot and stem:
                    file_name = f"{stem}({i}).{ext}"
                else:
                    file_name = f"{file_name}({i})"
                target = partition / file_name
                i += 1
            doc_id = new_id("d")
            restored_to = win_join(*[n["folder"] for n in chain], ref["doc_type"], file_name)
        if td.exists():
            src = td / ref["file_name"]
            if src.exists():
                shutil.move(str(src), str(target))
            shutil.rmtree(td, ignore_errors=True)
        db.execute(
            "INSERT OR REPLACE INTO docs (id, project_id, node_id, doc_type, file_name, "
            "current_version, missing, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?)",
            (doc_id, project_id, node_id, ref["doc_type"], file_name,
             ref.get("current_version", 1), ref.get("created_at") or now_iso(), now_iso()),
        )
    db.execute("DELETE FROM trash WHERE id=?", (trash_id,))
    sync_project_json(db, project_id)
    append_op_log(db, project_id, "trash.restore", {"trash_id": trash_id, "path": restored_to})
    return {"restored_to": restored_to}


def purge_expired_trash(db: Database, project_id: str) -> int:
    """启动自动清理：逾期项静默物理删除并写日志（PRD 6.3）。"""
    project = db.get_project(project_id)
    if not project:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    expired = db.query("SELECT * FROM trash WHERE project_id=? AND expires_at < ?", (project_id, now))
    for item in expired:
        _purge_trash_item(db, project, item)
    if expired:
        sync_project_json(db, project_id)
        append_op_log(db, project_id, "trash.auto_purge", {"count": len(expired)})
    return len(expired)


# ---------------------------------------------------------------------------
# 刷新同步（全量扫描，MVP 5.6）
# ---------------------------------------------------------------------------

def scan_workspace(db: Database, project_id: str) -> dict:
    """全量扫描：磁盘 ↔ 元数据比对。

    - 磁盘有而元数据无 → 自动登记（分配 docId，v1，来源 scan）
    - 元数据有而磁盘无 → 标记 missing（不自动删除登记）
    - 节点文件夹根部的散落文件/未登记文件夹/结构异常 → 报告提示
    """
    project = db.get_project(project_id)
    if not project:
        raise FsError("E_NOT_FOUND", "工作空间不存在")
    fs_root = Path(project["fs_root"])
    registered, missing, recovered = 0, 0, 0
    loose_files: list[str] = []
    unregistered_folders: list[str] = []
    broken_nodes: list[str] = []

    nodes = db.query("SELECT * FROM nodes WHERE project_id=? AND deleted=0", (project_id,))
    node_map = {n["id"]: n for n in nodes}

    def rel_win(path: Path) -> str:
        return win_join(*path.relative_to(fs_root).parts)

    for node in nodes:
        chain = node_chain(db, node)
        ndir = node_dir(fs_root, chain)
        if not ndir.exists():
            broken_nodes.append(rel_win(ndir))
            continue
        # 五类分区内文件
        indexed = {(d["doc_type"], d["file_name"]): d
                   for d in db.query("SELECT * FROM docs WHERE node_id=?", (node["id"],))}
        seen: set[tuple[str, str]] = set()
        for t in DOC_TYPES:
            tdir = ndir / t
            if not tdir.exists():
                for (dt, fn), d in indexed.items():
                    if dt == t and not d["missing"]:
                        db.execute("UPDATE docs SET missing=1 WHERE id=?", (d["id"],))
                        missing += 1
                continue
            for f in sorted(tdir.iterdir()):
                if f.is_dir():
                    continue
                key = (t, f.name)
                seen.add(key)
                if key in indexed:
                    if indexed[key]["missing"]:
                        db.execute("UPDATE docs SET missing=0 WHERE id=?", (indexed[key]["id"],))
                        recovered += 1
                else:
                    doc_id = new_id("d")
                    db.execute(
                        "INSERT INTO docs (id, project_id, node_id, doc_type, file_name, current_version, "
                        "missing, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)",
                        (doc_id, project_id, node["id"], t, f.name, now_iso(), now_iso()),
                    )
                    registered += 1
        for (dt, fn), d in indexed.items():
            if (dt, fn) not in seen and not d["missing"]:
                db.execute("UPDATE docs SET missing=1 WHERE id=?", (d["id"],))
                missing += 1
        # 节点文件夹根部散落文件 + 未登记文件夹
        for f in sorted(ndir.iterdir()):
            if f.name in DOC_TYPES or f.is_symlink():
                continue
            if f.is_dir():
                if f.name == ".yonman":
                    continue
                # 是否为已登记子节点
                if not db.one("SELECT 1 FROM nodes WHERE parent_id=? AND folder=?", (node["id"], f.name)):
                    unregistered_folders.append(rel_win(f))
            else:
                loose_files.append(rel_win(f))

    sync_project_json(db, project_id)
    summary = {
        "registered": registered, "missing": missing, "recovered": recovered,
        "loose_files": loose_files, "unregistered_folders": unregistered_folders,
        "broken_nodes": broken_nodes,
    }
    append_op_log(db, project_id, "scan.refresh", summary)
    return summary
