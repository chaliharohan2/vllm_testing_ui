"""Artifacts: standalone documents, code, HTML pages or SVGs shown beside the chat.

They are stored in SQLite with every version. After a successful call the agent puts
the artifact's placeholder, ``[title](#artifact/<id>/<version>)``, on its own paragraph
in the answer; the UI loads the artifact by id when it renders the placeholder.
"""

from __future__ import annotations

from typing import Any

from agent_server.text_filters import placeholder_link
from agent_server.tools.base import ToolContext, ToolError, ToolResult, ToolSpec, obj

KINDS = ("markdown", "code", "html", "svg", "mermaid", "text")
MAX_CONTENT = 400_000


def _check_content(content: Any) -> str:
    if not isinstance(content, str) or not content.strip():
        raise ToolError("content must be a non-empty string")
    if len(content) > MAX_CONTENT:
        raise ToolError(f"content is longer than {MAX_CONTENT:,} characters")
    return content


def _own_artifact(ctx: ToolContext, artifact_id: Any) -> dict[str, Any]:
    artifact = ctx.db.get_artifact(str(artifact_id or "").strip())
    if artifact is None or artifact["chat_id"] != ctx.chat_id:
        raise ToolError(f"no artifact {artifact_id!r} in this chat. Use the id from create_artifact's result.")
    return artifact


async def create_artifact(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    title = str(args.get("title") or "").strip()[:120]
    kind = str(args.get("type") or "").strip().lower()
    if not title:
        raise ToolError("title is required")
    if kind not in KINDS:
        raise ToolError(f"type must be one of {', '.join(KINDS)}")
    content = _check_content(args.get("content"))
    language = str(args.get("language") or "").strip().lower()[:30] if kind == "code" else ""
    artifact = ctx.db.create_artifact(ctx.chat_id, ctx.message_id, title, kind, language, content)
    return ToolResult(
        f"Created artifact {artifact['id']} (version 1, {kind}). The user sees it in your answer at this point. "
        "Do not repeat its content in your reply; refer to it briefly. To change it later, call "
        f"update_artifact with artifact_id {artifact['id']}.",
        summary=f"{title} · {kind}", placeholder=placeholder_link(artifact["id"], 1, title))


async def update_artifact(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    current = _own_artifact(ctx, args.get("artifact_id"))
    title = str(args.get("title") or "").strip()[:120] or current["title"]
    if isinstance(args.get("content"), str) and args["content"].strip():
        content = _check_content(args["content"])
    else:
        old, new = args.get("old_string"), args.get("new_string")
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise ToolError("give either content (the whole new version) or old_string and new_string")
        count = current["content"].count(old)
        if count != 1:
            raise ToolError("old_string was not found" if count == 0 else
                            f"old_string appears {count} times; include more surrounding text")
        content = current["content"].replace(old, new, 1)
    updated = ctx.db.add_artifact_version(current["id"], ctx.message_id, title, content)
    return ToolResult(
        f"Updated artifact {updated['id']} to version {updated['version']}. The user sees the new version in "
        "your answer at this point; do not repeat its content.",
        summary=f"{title} · v{updated['version']}",
        placeholder=placeholder_link(updated["id"], updated["version"], title))


async def read_artifact(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    artifact = _own_artifact(ctx, args.get("artifact_id"))
    return ToolResult(f"{artifact['title']} ({artifact['kind']}, version {artifact['version']}):\n\n"
                      f"{artifact['content']}", summary=f"{artifact['title']} · v{artifact['version']}")


TOOLS = [
    ToolSpec(
        "create_artifact", "artifacts",
        "Show substantial, self-contained content in a panel beside the chat, where the user can view, copy "
        "and download it: documents and reports (markdown), code files (code), web pages or interactive demos "
        "(html, a full page with inline CSS/JS), images and diagrams (svg, or mermaid for flowcharts). Use it "
        "for content over ~15 lines that the user will reuse or edit, not for short answers, snippets or "
        "explanations. The artifact appears in your answer where you call this.",
        obj({"title": {"type": "string", "description": "Short title shown on the artifact."},
             "type": {"type": "string", "enum": list(KINDS)},
             "language": {"type": "string", "description": "For type code: the language, e.g. python."},
             "content": {"type": "string", "description": "The complete content."}},
            ["title", "type", "content"]),
        create_artifact, main_only=True),
    ToolSpec(
        "update_artifact", "artifacts",
        "Make a new version of an artifact from this chat. Either give content (the whole new version) or "
        "old_string and new_string to replace one unique passage.",
        obj({"artifact_id": {"type": "string"}, "title": {"type": "string", "description": "Optional new title."},
             "content": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}},
            ["artifact_id"]),
        update_artifact, main_only=True),
    ToolSpec("read_artifact", "artifacts", "Read the latest version of an artifact from this chat.",
             obj({"artifact_id": {"type": "string"}}, ["artifact_id"]), read_artifact, main_only=True),
]
