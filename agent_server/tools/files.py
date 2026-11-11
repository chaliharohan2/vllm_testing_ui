"""File tools, confined to the chat's working folder."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from agent_server.tools.base import ToolContext, ToolError, ToolResult, ToolSpec, obj

MAX_READ_LINES = 2000
MAX_LINE_CHARS = 2000
MAX_LIST_ENTRIES = 400
SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "build"}


def resolve(ctx: ToolContext, path: str) -> Path:
    if not isinstance(path, str) or not path.strip():
        raise ToolError("path is required")
    root = ctx.workdir.resolve()
    candidate = Path(path.strip()).expanduser()
    target = (candidate if candidate.is_absolute() else root / candidate).resolve()
    if target != root and root not in target.parents:
        raise ToolError(f"{path} is outside the working folder {root}. Use a path inside it.")
    return target


def show(ctx: ToolContext, path: Path) -> str:
    root = ctx.workdir.resolve()
    return "." if path == root else str(path.relative_to(root))


async def list_files(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    base = resolve(ctx, args.get("path") or ".")
    depth = max(1, min(int(args.get("depth") or 2), 6))
    if not base.exists():
        raise ToolError(f"{args.get('path')} does not exist")
    if base.is_file():
        return ToolResult(f"{show(ctx, base)} ({base.stat().st_size} bytes)", summary=show(ctx, base))
    lines: list[str] = []

    def walk(folder: Path, level: int) -> None:
        try:
            entries = sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            lines.append("  " * level + "[permission denied]")
            return
        for entry in entries:
            if len(lines) >= MAX_LIST_ENTRIES:
                return
            if entry.is_dir():
                lines.append("  " * level + entry.name + "/")
                if entry.name not in SKIP_DIRS and level + 1 < depth:
                    walk(entry, level + 1)
            else:
                lines.append("  " * level + f"{entry.name} ({entry.stat().st_size} bytes)")

    walk(base, 0)
    if len(lines) >= MAX_LIST_ENTRIES:
        lines.append(f"[stopped at {MAX_LIST_ENTRIES} entries; list a subfolder to see more]")
    text = f"{show(ctx, base)}/\n" + ("\n".join("  " + line for line in lines) if lines else "  (empty)")
    return ToolResult(text, summary=f"{show(ctx, base)}: {len(lines)} entries")


async def read_file(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    target = resolve(ctx, args.get("path"))
    if not target.is_file():
        raise ToolError(f"{args.get('path')} is not a file")
    data = target.read_bytes()
    if b"\0" in data[:8000]:
        raise ToolError(f"{show(ctx, target)} is a binary file ({len(data)} bytes)")
    lines = data.decode("utf-8", errors="replace").splitlines()
    offset = max(1, int(args.get("offset") or 1))
    limit = max(1, min(int(args.get("limit") or MAX_READ_LINES), MAX_READ_LINES))
    chunk = lines[offset - 1: offset - 1 + limit]
    numbered = "\n".join(f"{offset + i:6}|{line[:MAX_LINE_CHARS]}" for i, line in enumerate(chunk))
    more = len(lines) - (offset - 1 + len(chunk))
    if more > 0:
        numbered += f"\n[{more} more lines; read again with offset={offset + len(chunk)}]"
    return ToolResult(numbered or "(empty file)",
                      summary=f"{show(ctx, target)}: lines {offset}-{offset + len(chunk) - 1} of {len(lines)}")


async def write_file(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    target = resolve(ctx, args.get("path"))
    content = args.get("content")
    if not isinstance(content, str):
        raise ToolError("content must be a string")
    if target.is_dir():
        raise ToolError(f"{show(ctx, target)} is a folder")
    existed = target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    verb = "Overwrote" if existed else "Created"
    return ToolResult(f"{verb} {show(ctx, target)} ({len(content.splitlines())} lines).",
                      summary=f"{verb.lower()} {show(ctx, target)}")


async def edit_file(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    target = resolve(ctx, args.get("path"))
    old, new = args.get("old_string"), args.get("new_string")
    if not isinstance(old, str) or not isinstance(new, str):
        raise ToolError("old_string and new_string must be strings")
    if not old:
        raise ToolError("old_string is empty; use write_file to create or replace a whole file")
    if old == new:
        raise ToolError("old_string and new_string are the same")
    if not target.is_file():
        raise ToolError(f"{args.get('path')} is not a file")
    text = target.read_text(encoding="utf-8", errors="replace")
    count = text.count(old)
    if count == 0:
        raise ToolError("old_string was not found. Read the file again and copy the exact text, "
                        "including whitespace.")
    if count > 1 and not args.get("replace_all"):
        raise ToolError(f"old_string appears {count} times. Add surrounding lines to make it unique, "
                        "or set replace_all to true.")
    target.write_text(text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1),
                      encoding="utf-8")
    replaced = count if args.get("replace_all") else 1
    return ToolResult(f"Edited {show(ctx, target)}: {replaced} replacement{'s' if replaced > 1 else ''}.",
                      summary=f"edited {show(ctx, target)}")


async def delete_file(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    target = resolve(ctx, args.get("path"))
    if target == ctx.workdir.resolve():
        raise ToolError("refusing to delete the working folder itself")
    if not target.exists() and not target.is_symlink():
        raise ToolError(f"{args.get('path')} does not exist")
    if target.is_dir() and not target.is_symlink():
        if any(target.iterdir()) and not args.get("recursive"):
            raise ToolError(f"{show(ctx, target)} is a folder that is not empty; set recursive to true to "
                            "delete it with everything in it")
        shutil.rmtree(target)
        return ToolResult(f"Deleted folder {show(ctx, target)}.", summary=f"deleted {show(ctx, target)}/")
    target.unlink()
    return ToolResult(f"Deleted {show(ctx, target)}.", summary=f"deleted {show(ctx, target)}")


PATH = {"type": "string", "description": "Path relative to the working folder (or absolute, inside it)."}

TOOLS = [
    ToolSpec("list_files", "files", "List files and folders in the working folder as a tree.",
             obj({"path": {**PATH, "description": "Folder to list. Defaults to the working folder."},
                  "depth": {"type": "integer", "description": "How many levels deep (1-6, default 2)."}}, []),
             list_files),
    ToolSpec("read_file", "files", "Read a text file. Lines come back numbered as `   N|text`; the numbers "
             "are not part of the file.",
             obj({"path": PATH,
                  "offset": {"type": "integer", "description": "First line to read (1-based)."},
                  "limit": {"type": "integer", "description": f"Lines to read (max {MAX_READ_LINES})."}},
                 ["path"]), read_file),
    ToolSpec("write_file", "files", "Create a file, or replace a file's whole content. Parent folders are "
             "created. Prefer edit_file for changes to an existing file.",
             obj({"path": PATH, "content": {"type": "string", "description": "The full file content."}},
                 ["path", "content"]), write_file),
    ToolSpec("edit_file", "files", "Replace exact text in a file. old_string must match the file exactly "
             "(whitespace too) and be unique unless replace_all is true. Read the file first.",
             obj({"path": PATH, "old_string": {"type": "string"}, "new_string": {"type": "string"},
                  "replace_all": {"type": "boolean", "description": "Replace every occurrence."}},
                 ["path", "old_string", "new_string"]), edit_file),
    ToolSpec("delete_file", "files", "Delete a file, or a folder (recursive must be true for a folder "
             "that is not empty).",
             obj({"path": PATH, "recursive": {"type": "boolean"}}, ["path"]), delete_file),
]
