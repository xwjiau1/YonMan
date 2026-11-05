"""SQLite 数据层（轻量级本地数据库，PRD 3.1：文件系统 + SQLite）。

存：项目/节点元数据、文档索引与版本记录、回收登记、操作日志。
文档本体即文件（文件夹即真相，project.json 同步落盘）。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  win_path TEXT NOT NULL,
  fs_root TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'managed',
  manager TEXT NOT NULL DEFAULT '',
  customer TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  product_line TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 1,
  folder TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id, parent_id, seq);

CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  missing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_id, doc_type, file_name)
);
CREATE INDEX IF NOT EXISTS idx_docs_node ON docs(node_id, doc_type);

CREATE TABLE IF NOT EXISTS doc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  stamp TEXT NOT NULL,
  size INTEGER NOT NULL,
  source TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(doc_id, version)
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(doc_id);

CREATE TABLE IF NOT EXISTS trash (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- node | doc
  name TEXT NOT NULL,
  original_path TEXT NOT NULL,      -- Windows 风格相对路径（保持目录结构）
  original_ref TEXT NOT NULL DEFAULT '{}',
  deleted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trash_project ON trash(project_id);

CREATE TABLE IF NOT EXISTS op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class Database:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "yonman.db"
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        try:
            self._conn.execute("PRAGMA journal_mode = WAL")
            # WAL 在首次写时才真正生效，探针确认当前文件系统可用
            self._conn.execute("CREATE TABLE IF NOT EXISTS _probe (id INTEGER)")
            self._conn.execute("INSERT INTO _probe VALUES (1)")
            self._conn.execute("DROP TABLE _probe")
            self._conn.commit()
        except sqlite3.Error:
            # 部分文件系统（如 FUSE/portal 挂载）不支持 WAL，回退默认日志模式
            self._conn.close()
            self._conn = sqlite3.connect(self.path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode = DELETE")
        with _lock:
            self._conn.executescript(SCHEMA)
            self._migrate()
            self._conn.commit()

    def _migrate(self) -> None:
        """幂等迁移：为旧库补齐新增列。"""
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(projects)")}
        if "mode" not in cols:
            self._conn.execute("ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'managed'")

    # -- 基础查询 ------------------------------------------------------

    def query(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with _lock:
            return self._conn.execute(sql, args).fetchall()

    def one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        with _lock:
            return self._conn.execute(sql, args).fetchone()

    def execute(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with _lock:
            cur = self._conn.execute(sql, args)
            self._conn.commit()
            return cur

    def executescript(self, sql: str) -> None:
        with _lock:
            self._conn.executescript(sql)
            self._conn.commit()

    # -- 领域操作 ------------------------------------------------------

    def get_project(self, project_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM projects WHERE id = ?", (project_id,))

    def log(self, project_id: str, action: str, detail: dict) -> None:
        self.execute(
            "INSERT INTO op_logs (project_id, action, detail, created_at) VALUES (?,?,?,?)",
            (project_id, action, json.dumps(detail, ensure_ascii=False), now_iso()),
        )

    def recent_projects(self, limit: int = 10) -> list[sqlite3.Row]:
        return self.query(
            "SELECT * FROM projects ORDER BY COALESCE(last_opened_at, created_at) DESC LIMIT ?",
            (limit,),
        )
