"""Filters for the streamed answer text. Text can arrive split over many chunks."""

from __future__ import annotations

import re

ARTIFACT_LINK = "#artifact/"


def placeholder_link(artifact_id: str, version: int, title: str) -> str:
    label = " ".join(re.sub(r"[\[\]]", " ", title).split()) or "Artifact"
    return f"[{label}]({ARTIFACT_LINK}{artifact_id}/{version})"


class PlaceholderFilter:
    """Turns any [label](#artifact/...) link the model writes itself into its plain label.

    The UI only gets placeholders the server inserted after a tool succeeded. Text from
    a "[" is held back until it is clearly a placeholder or clearly not one.
    """

    LINK = re.compile(r"\[([^\]\n]*)\]\(#artifact/[^)\s]*\)")
    LABEL = re.compile(r"\[[^\]\n]*")
    TARGET = "](" + ARTIFACT_LINK
    MAX_PENDING = 300

    def __init__(self) -> None:
        self.pending = ""

    def feed(self, text: str) -> str:
        self.pending += text
        visible: list[str] = []
        while self.pending:
            start = self.pending.find("[")
            if start < 0:
                visible.append(self.pending)
                self.pending = ""
                break
            visible.append(self.pending[:start])
            self.pending = self.pending[start:]
            match = self.LINK.match(self.pending)
            if match:
                visible.append(match.group(1))
                self.pending = self.pending[match.end():]
                continue
            if self._could_become_link(self.pending) and len(self.pending) < self.MAX_PENDING:
                break
            visible.append("[")
            self.pending = self.pending[1:]
        return "".join(visible)

    def flush(self) -> str:
        rest, self.pending = self.pending, ""
        return rest

    def _could_become_link(self, text: str) -> bool:
        rest = text[self.LABEL.match(text).end():]
        if len(rest) <= len(self.TARGET):
            return self.TARGET.startswith(rest)
        return rest.startswith(self.TARGET) and re.fullmatch(r"[^)\s]*", rest[len(self.TARGET):]) is not None


class ToolCallTextFilter:
    """Hides a tool call the model wrote as text (``<tool_call>`` / ``<function=``) and
    everything after it. The agent parses the full text afterwards."""

    MARKERS = ("<tool_call>", "<function=")

    def __init__(self) -> None:
        self.pending = ""
        self.hiding = False

    def feed(self, text: str) -> str:
        if self.hiding:
            return ""
        self.pending += text
        for marker in self.MARKERS:
            index = self.pending.find(marker)
            if index >= 0:
                self.hiding = True
                visible, self.pending = self.pending[:index], ""
                return visible
        keep = 0
        for marker in self.MARKERS:
            for size in range(min(len(marker) - 1, len(self.pending)), 0, -1):
                if marker.startswith(self.pending[-size:]):
                    keep = max(keep, size)
                    break
        visible = self.pending[: len(self.pending) - keep]
        self.pending = self.pending[len(self.pending) - keep:]
        return visible

    def flush(self) -> str:
        rest, self.pending = ("" if self.hiding else self.pending), ""
        return rest
