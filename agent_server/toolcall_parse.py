"""Recover tool calls that a model emitted as plain text.

vLLM normally returns structured ``tool_calls``. When its parser misses a call,
it arrives inside ``content`` instead. Recognised formats:

* Hermes / Qwen JSON:      ``<tool_call>{"name": ..., "arguments": {...}}</tool_call>``
* Qwen3.5+ "coder" XML:    ``<tool_call><function=NAME><parameter=P>value</parameter></function></tool_call>``
* fenced JSON:             ```` ```json {"name": ..., "arguments": {...}} ``` ````

Ported from deck-creator-agent.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

_TOOL_CALL_BLOCK = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|$)", re.S)
_FUNCTION_XML = re.compile(r"<function=([\w.\-]+)>\s*(.*?)\s*(?:</function>|$)", re.S)
_PARAM_XML = re.compile(r"<parameter=([\w.\-]+)>\s*?\n?(.*?)\n?\s*</parameter>", re.S)
_FENCE = re.compile(r"```(?:json|tool_call|tool_code)?\s*(\{.*?\})\s*```", re.S)


@dataclass
class ParsedCall:
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


def parse_arguments(raw: Any) -> tuple[dict[str, Any], str | None]:
    """Parse tool-call arguments into a dict, tolerating common JSON slips."""
    if raw is None or raw == "":
        return {}, None
    if isinstance(raw, dict):
        return raw, None
    if not isinstance(raw, str):
        return {}, f"arguments must be a JSON object, got {type(raw).__name__}"
    text = raw.strip()
    candidates = [text, re.sub(r",\s*([}\]])", r"\1", text)]
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        candidates.append(re.sub(r",\s*([}\]])", r"\1", match.group(0)))
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, str):  # double-encoded JSON
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        if isinstance(value, dict):
            return value, None
    return {}, "arguments were not valid JSON; send a single JSON object with the tool's parameters"


def _xml_value(raw: str) -> Any:
    value = raw.strip()
    if value[:1] in "[{" or value in ("true", "false", "null") or re.fullmatch(r"-?\d+(\.\d+)?", value):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            pass
    return value


def _from_json_obj(obj: Any, known: set[str]) -> ParsedCall | None:
    if not isinstance(obj, dict):
        return None
    if "function" in obj and isinstance(obj["function"], dict):
        obj = obj["function"]
    name = obj.get("name") or obj.get("tool") or obj.get("tool_name")
    if not isinstance(name, str) or (known and name not in known):
        return None
    args, error = parse_arguments(obj.get("arguments", obj.get("parameters", obj.get("args", {}))))
    return ParsedCall(name=name, arguments=args, error=error)


def extract_tool_calls(text: str, known_tools: set[str] | None = None) -> tuple[list[ParsedCall], str]:
    """Find tool calls embedded in ``text``. Returns ``(calls, remaining_text)``.

    Fenced JSON only counts for names in ``known_tools``, so ordinary JSON in an
    answer is not mistaken for a call.
    """
    known = known_tools or set()
    calls: list[ParsedCall] = []

    for block in _TOOL_CALL_BLOCK.finditer(text):
        body = block.group(1)
        function = _FUNCTION_XML.search(body)
        if function:
            args = {m.group(1): _xml_value(m.group(2)) for m in _PARAM_XML.finditer(function.group(2))}
            calls.append(ParsedCall(name=function.group(1), arguments=args))
            continue
        try:
            parsed = _from_json_obj(json.loads(body), set())
        except json.JSONDecodeError:
            obj_args, error = parse_arguments(body)
            parsed = _from_json_obj(obj_args, set()) if not error else None
        if parsed:
            calls.append(parsed)
    if calls:
        return calls, _TOOL_CALL_BLOCK.sub("", text).strip()

    for function in _FUNCTION_XML.finditer(text):
        args = {m.group(1): _xml_value(m.group(2)) for m in _PARAM_XML.finditer(function.group(2))}
        calls.append(ParsedCall(name=function.group(1), arguments=args))
    if calls:
        return calls, _FUNCTION_XML.sub("", text).strip()

    remaining = text
    for fence in _FENCE.finditer(text):
        try:
            parsed = _from_json_obj(json.loads(fence.group(1)), known)
        except json.JSONDecodeError:
            parsed = None
        if parsed:
            calls.append(parsed)
            remaining = remaining.replace(fence.group(0), "")
    if calls:
        return calls, remaining.strip()
    return [], text
