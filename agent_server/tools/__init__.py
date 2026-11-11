"""Tool registry. The UI turns tools on and off by group."""

from __future__ import annotations

from agent_server.tools import artifacts, bash, browser, files, subagents, web
from agent_server.tools.base import ToolGroup, ToolSpec

GROUPS: list[ToolGroup] = [
    ToolGroup("files", "Files", "Read, create, edit and delete files in the working folder."),
    ToolGroup("bash", "Terminal", "Run bash commands in the working folder. sudo asks you first."),
    ToolGroup("web_search", "Web search", "Keyless web search (ddgs, Wikipedia fallback)."),
    ToolGroup("web_fetch", "Web fetch", "Read web pages and PDFs as text."),
    ToolGroup("browser", "Browser", "Drive a real Chromium with browser-use."),
    ToolGroup("artifacts", "Artifacts", "Documents, code, pages and diagrams in a side panel."),
    ToolGroup("subagents", "Subagents", "Delegate tasks to parallel subagents."),
]

TOOLS: dict[str, ToolSpec] = {
    spec.name: spec
    for module in (files, bash, web, browser, artifacts, subagents)
    for spec in module.TOOLS
}

for group in GROUPS:
    group.tools = [spec.name for spec in TOOLS.values() if spec.group == group.id]

GROUP_IDS = [group.id for group in GROUPS]


def tools_for_groups(groups: list[str], depth: int = 0) -> list[ToolSpec]:
    wanted = set(groups)
    return [spec for spec in TOOLS.values()
            if spec.group in wanted and not (depth > 0 and spec.main_only)]
