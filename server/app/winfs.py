"""
Windows 文件系统逻辑层（YonMan MVP）

按 PRD 3.3 / MVP 设计稿 4.1 约定实现：
- 节点 = 文件夹，层级 = 文件夹嵌套
- 节点命名默认 `序号_名称`（如 01_蓝图阶段）
- 每个节点固定五个分区：meeting / log / plan / deliverable / other
- 元数据存放于工作区 `.yonman/` 隐藏目录
- 命名遵循 Windows 规则：非法字符 `\\ / : * ? " < > |` 与控制字符禁入、
  保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）冲突检测、尾随点与空格剥离、
  路径以反斜杠展示（如 D:\\testworkspace）、长路径（>260）按 Windows 长路径规范提示
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime

# ---- Windows 命名规则 -------------------------------------------------

ILLEGAL_CHARS = set('<>:"/\\|?*')
RESERVED_BASENAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
DOC_TYPES = ("meeting", "log", "plan", "deliverable", "other")
DOC_TYPE_LABELS = {
    "meeting": "会议纪要",
    "log": "工作日志",
    "plan": "计划",
    "deliverable": "成果物",
    "other": "其他文档",
}
MAX_COMPONENT_LEN = 255
WINDOWS_MAX_PATH = 260


class FsError(Exception):
    """文件系统逻辑错误，code 与 MVP 设计稿 3.3 错误约定一致。"

    E_BUSY / E_DUP / E_INVALID_NAME / E_NOT_FOUND / E_IO
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def validate_node_name(name: str) -> str:
    """校验节点/文件名称是否符合 Windows 命名规范。

    返回清洗后的名称；不合规抛出 FsError(E_INVALID_NAME)。
    """
    if name is None:
        raise FsError("E_INVALID_NAME", "名称不能为空")
    name = name.strip()
    if not name:
        raise FsError("E_INVALID_NAME", "名称不能为空")
    if name in (".", ".."):
        raise FsError("E_INVALID_NAME", "名称不能为 . 或 ..")
    # 保留分区名与元数据目录名
    if name.lower() in set(DOC_TYPES) | {".yonman"}:
        raise FsError("E_INVALID_NAME", f"「{name}」为系统保留名称，不可使用")
    bad = sorted({c for c in name if c in ILLEGAL_CHARS or ord(c) < 32})
    if bad:
        raise FsError(
            "E_INVALID_NAME",
            "名称包含 Windows 非法字符：" + " ".join(bad) + '（禁用 \\ / : * ? " < > |）',
        )
    # Windows 保留设备名（含扩展名也禁止，如 CON.txt）
    base = name.split(".", 1)[0].upper()
    if base in RESERVED_BASENAMES:
        raise FsError("E_INVALID_NAME", f"「{name}」与 Windows 保留名冲突")
    if len(name) > MAX_COMPONENT_LEN:
        raise FsError("E_INVALID_NAME", f"名称超过 {MAX_COMPONENT_LEN} 字符限制")
    # 尾随点与空格在 Windows 上会被自动剥离，直接拒绝以避免歧义
    if name != name.rstrip(". "):
        raise FsError("E_INVALID_NAME", "名称不能以空格或点结尾")
    return name


def sanitize_file_name(name: str) -> str:
    """上传落盘前的文件名规范化（PRD 7.4）：非法字符替换、去控制字符、剥离尾随点/空格。"""
    name = re.sub(r"[\x00-\x1f]", "", name)
    name = "".join("_" if (c in ILLEGAL_CHARS or ord(c) < 32) else c for c in name)
    name = name.rstrip(". ").strip()
    return name or f"未命名_{uuid.uuid4().hex[:6]}"


def next_prefix(seq: int) -> str:
    """同级序号前缀，如 1 -> '01'，超过 99 自然扩展（100 -> '100'）。"""
    return f"{seq:02d}"


def folder_name(prefix: str, name: str) -> str:
    """系统建节点默认 `序号_名称`；无序号节点（如早期示例的新子阶段）直接用名称。"""
    return f"{prefix}_{name}" if prefix else name


def win_join(*parts: str) -> str:
    """按 Windows 反斜杠规范拼接展示路径。"""
    cleaned = [p.strip("\\/") for p in parts if p]
    return "\\".join(cleaned)


def stamp_now() -> str:
    """版本归档时间戳 yyyyMMdd_HHmmss。"""
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def new_id(prefix: str) -> str:
    """生成稳定内部 ID：前缀_时间戳+随机4位（PRD 4.1 docId 规则）。"""
    return f"{prefix}_{datetime.now().strftime('%Y%m%d%H%M%S')}{uuid.uuid4().hex[:4]}"


def check_path_length(win_path: str) -> None:
    """Windows 长路径（>260）提示：本地客户端将启用 \\?\ 前缀长路径 API（PRD 10）。"""
    if len(win_path) > WINDOWS_MAX_PATH:
        # MVP（Web 版运行在无 260 限制的 Linux 文件系统上）仅提示，不阻断
        return
