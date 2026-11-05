"""YonMan MVP — FastAPI 应用入口。

REST API 契约与 MVP 设计稿 3.3 IPC 清单一一对应：
工作区 / 树 / 文档 / 版本 / 回收站 / 扫描，统一错误约定 {ok:false, code, message}。
生产模式由本服务同时托管前端构建产物（dist/）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .db import Database
from .winfs import FsError
from . import services as svc

BASE_DIR = Path(__file__).resolve().parent.parent          # server/
DATA_DIR = Path(os.environ.get("YONMAN_DATA_DIR", BASE_DIR / "data"))
DIST_DIR = Path(os.environ.get("YONMAN_DIST_DIR", BASE_DIR.parent / "dist"))

db = Database(DATA_DIR)
app = FastAPI(title="YonMan MVP", version="0.1.0")


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------

class WorkspaceCreate(BaseModel):
    name: str
    manager: Optional[str] = ""
    customer: Optional[str] = ""
    industry: Optional[str] = ""
    product_line: Optional[str] = ""


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    manager: Optional[str] = None
    customer: Optional[str] = None
    industry: Optional[str] = None
    product_line: Optional[str] = None


class LocalWorkspaceCreate(BaseModel):
    name: str
    path: str
    manager: Optional[str] = ""
    customer: Optional[str] = ""
    industry: Optional[str] = ""
    product_line: Optional[str] = ""


class NodeCreate(BaseModel):
    parent_id: Optional[str] = None
    name: str


class NodeRename(BaseModel):
    name: str


class NodeMove(BaseModel):
    new_parent_id: Optional[str] = None
    new_index: int = 0


class RemarkSet(BaseModel):
    remark: str


class DocRename(BaseModel):
    new_name: str


# ---------------------------------------------------------------------------
# 错误处理
# ---------------------------------------------------------------------------

@app.exception_handler(FsError)
async def fs_error_handler(_, exc: FsError):
    status = {
        "E_NOT_FOUND": 404, "E_DUP": 409, "E_INVALID_NAME": 422,
        "E_BUSY": 423, "E_IO": 500,
    }.get(exc.code, 400)
    return JSONResponse(status_code=status, content={"ok": False, "code": exc.code, "message": exc.message})


def ok(data: dict) -> dict:
    return {"ok": True, **data}


# ---------------------------------------------------------------------------
# 系统 / 特性开关
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return ok({"status": "up", "app": "yonman", "version": "0.1.0"})


@app.get("/api/features")
def features():
    """MVP 特性开关：对话 Tab 与资产库为占位（MVP 设计稿 1.2）。"""
    return ok({"chat": False, "asset_library": False})


# ---------------------------------------------------------------------------
# 工作区
# ---------------------------------------------------------------------------

@app.post("/api/workspaces")
def create_workspace(data: WorkspaceCreate):
    return ok({"project": svc.create_workspace(db, data)})


@app.post("/api/workspaces/local")
def create_local_workspace(data: LocalWorkspaceCreate):
    return ok({"project": svc.create_local_workspace(db, data)})


@app.get("/api/workspaces")
def list_workspaces():
    return ok({"items": svc.list_workspaces(db)})


@app.get("/api/workspaces/{pid}")
def workspace_detail(pid: str):
    return ok({"project": svc.get_workspace(db, pid)})


@app.post("/api/workspaces/{pid}/open")
def open_workspace(pid: str):
    return ok({"project": svc.open_workspace(db, pid)})


@app.patch("/api/workspaces/{pid}")
def update_workspace(pid: str, data: WorkspaceUpdate):
    return ok({"project": svc.update_workspace(db, pid, data)})


# ---------------------------------------------------------------------------
# 阶段-事项树
# ---------------------------------------------------------------------------

@app.get("/api/workspaces/{pid}/tree")
def tree(pid: str):
    svc.get_workspace(db, pid)
    return ok({"nodes": svc.list_tree(db, pid)})


@app.post("/api/workspaces/{pid}/nodes")
def add_node(pid: str, data: NodeCreate):
    return ok({"node": svc.add_node(db, pid, data.parent_id, data.name)})


@app.patch("/api/workspaces/{pid}/nodes/{node_id}")
def rename_node(pid: str, node_id: str, data: NodeRename):
    svc.rename_node(db, pid, node_id, data.name)
    return ok({})


@app.post("/api/workspaces/{pid}/nodes/{node_id}/move")
def move_node(pid: str, node_id: str, data: NodeMove):
    svc.move_node(db, pid, node_id, data.new_parent_id, data.new_index)
    return ok({})


@app.delete("/api/workspaces/{pid}/nodes/{node_id}")
def delete_node(pid: str, node_id: str):
    return ok(svc.delete_node(db, pid, node_id))


@app.put("/api/workspaces/{pid}/nodes/{node_id}/remark")
def set_remark(pid: str, node_id: str, data: RemarkSet):
    svc.set_node_remark(db, pid, node_id, data.remark)
    return ok({})


@app.get("/api/workspaces/{pid}/nodes/{node_id}/doc-count")
def node_doc_count(pid: str, node_id: str):
    count = svc.node_recursive_doc_count(db, pid, node_id)
    return ok({"count": count})


# ---------------------------------------------------------------------------
# 文档
# ---------------------------------------------------------------------------

@app.get("/api/workspaces/{pid}/nodes/{node_id}/docs")
def list_docs(pid: str, node_id: str, doc_type: Optional[str] = None):
    return ok(svc.list_docs(db, pid, node_id, doc_type))


@app.post("/api/workspaces/{pid}/nodes/{node_id}/docs/upload")
async def upload_docs(pid: str, node_id: str, doc_type: str = Form(...),
                      policies: str = Form("{}"), files: list[UploadFile] = File(...)):
    try:
        policy_map = json.loads(policies)
    except json.JSONDecodeError:
        policy_map = {}
    return ok(svc.upload_docs(db, pid, node_id, doc_type, files, policy_map))


@app.get("/api/workspaces/{pid}/docs/{doc_id}/download")
def download_doc(pid: str, doc_id: str):
    doc = svc.get_doc(db, pid, doc_id)
    path = svc._doc_fs_path(db, pid, doc)
    if not path.exists():
        raise FsError("E_NOT_FOUND", "文件缺失，可能已被外部删除")
    return FileResponse(path, filename=doc["file_name"], media_type="application/octet-stream")


@app.get("/api/workspaces/{pid}/docs/{doc_id}/content")
def doc_content(pid: str, doc_id: str):
    """文本/图片类文档的在线预览内容。"""
    doc = svc.get_doc(db, pid, doc_id)
    path = svc._doc_fs_path(db, pid, doc)
    if not path.exists():
        raise FsError("E_NOT_FOUND", "文件缺失，可能已被外部删除")
    ext = path.suffix.lower()
    text_ext = {".txt", ".md", ".json", ".log", ".csv"}
    if ext in text_ext:
        return FileResponse(path, media_type="text/plain; charset=utf-8")
    if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        media = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".gif": "image/gif", ".webp": "image/webp"}[ext]
        return FileResponse(path, media_type=media)
    if ext == ".pdf":
        return FileResponse(path, media_type="application/pdf")
    return FileResponse(path, filename=doc["file_name"], media_type="application/octet-stream")


@app.post("/api/workspaces/{pid}/docs/{doc_id}/rename")
def rename_doc(pid: str, doc_id: str, data: DocRename):
    svc.rename_doc(db, pid, doc_id, data.new_name)
    return ok({})


@app.delete("/api/workspaces/{pid}/docs/{doc_id}")
def delete_doc(pid: str, doc_id: str):
    return ok(svc.delete_doc(db, pid, doc_id))


@app.get("/api/workspaces/{pid}/docs/{doc_id}/versions")
def list_versions(pid: str, doc_id: str):
    return ok(svc.list_versions(db, pid, doc_id))


@app.post("/api/workspaces/{pid}/docs/{doc_id}/versions/{version}/restore")
def restore_version(pid: str, doc_id: str, version: int):
    return ok(svc.restore_version(db, pid, doc_id, version))


@app.get("/api/workspaces/{pid}/docs/{doc_id}/versions/{version}/preview")
def preview_version(pid: str, doc_id: str, version: int):
    path = svc.preview_version(db, pid, doc_id, version)
    if not path.exists():
        raise FsError("E_NOT_FOUND", "版本文件缺失")
    return FileResponse(path, filename=path.name, media_type="application/octet-stream")


# ---------------------------------------------------------------------------
# 回收站
# ---------------------------------------------------------------------------

@app.get("/api/workspaces/{pid}/trash")
def trash_list(pid: str):
    svc.get_workspace(db, pid)
    return ok({"items": svc.list_trash(db, pid)})


@app.post("/api/workspaces/{pid}/trash/{trash_id}/restore")
def trash_restore(pid: str, trash_id: str):
    return ok(svc.restore_trash(db, pid, trash_id))


@app.delete("/api/workspaces/{pid}/trash/{trash_id}")
def trash_purge_one(pid: str, trash_id: str):
    return ok(svc.purge_trash(db, pid, trash_id))


@app.delete("/api/workspaces/{pid}/trash")
def trash_purge_all(pid: str):
    return ok(svc.purge_trash(db, pid, None))


# ---------------------------------------------------------------------------
# 刷新同步
# ---------------------------------------------------------------------------

@app.post("/api/workspaces/{pid}/scan")
def scan(pid: str):
    return ok({"summary": svc.scan_workspace(db, pid)})


# ---------------------------------------------------------------------------
# 前端静态资源（生产模式）
# ---------------------------------------------------------------------------

if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        candidate = DIST_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST_DIR / "index.html")
