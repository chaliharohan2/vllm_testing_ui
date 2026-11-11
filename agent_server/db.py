"""SQLite storage for chats, their messages and the artifacts created in them.

A user message keeps its text and image attachments. An assistant message keeps
``content`` (the answer markdown, with artifact placeholders), ``parts`` (what the
UI shows: reasoning, text and tool cards in order) and ``llm`` (the raw OpenAI-style
assistant/tool messages of the turn, replayed to the model on later turns).
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    parts TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    llm TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'completed',
    notice TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, seq);
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_versions (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (artifact_id, version)
);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


class Database:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("PRAGMA foreign_keys = ON")
            self._conn.execute("PRAGMA journal_mode = WAL")
            self._conn.executescript(SCHEMA)
            # a turn that was running when the server stopped can never finish now
            self._conn.execute("UPDATE messages SET status = 'interrupted' WHERE status = 'running'")
            self._conn.commit()

    def _run(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
            self._conn.commit()
            return rows

    # ------------------------------------------------------------------ chats

    def create_chat(self, title: str, settings: dict[str, Any]) -> dict[str, Any]:
        chat_id, now = new_id("chat"), time.time()
        self._run("INSERT INTO chats (id, title, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                  (chat_id, title, json.dumps(settings), now, now))
        return self.get_chat(chat_id)

    def get_chat(self, chat_id: str) -> dict[str, Any] | None:
        rows = self._run("SELECT * FROM chats WHERE id = ?", (chat_id,))
        if not rows:
            return None
        row = dict(rows[0])
        row["settings"] = json.loads(row["settings"])
        return row

    def list_chats(self) -> list[dict[str, Any]]:
        rows = self._run("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC")
        return [dict(row) for row in rows]

    def update_chat(self, chat_id: str, *, title: str | None = None, settings: dict[str, Any] | None = None) -> None:
        sets, params = ["updated_at = ?"], [time.time()]
        if title is not None:
            sets.append("title = ?")
            params.append(title)
        if settings is not None:
            sets.append("settings = ?")
            params.append(json.dumps(settings))
        self._run(f"UPDATE chats SET {', '.join(sets)} WHERE id = ?", (*params, chat_id))

    def delete_chat(self, chat_id: str) -> bool:
        exists = bool(self._run("SELECT 1 FROM chats WHERE id = ?", (chat_id,)))
        self._run("DELETE FROM chats WHERE id = ?", (chat_id,))
        return exists

    # ------------------------------------------------------------------ messages

    def add_message(self, chat_id: str, role: str, *, content: str = "", attachments: list | None = None,
                    status: str = "completed") -> str:
        message_id = new_id("msg")
        with self._lock:
            seq = self._conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE chat_id = ?",
                                     (chat_id,)).fetchone()[0]
            self._conn.execute(
                "INSERT INTO messages (id, chat_id, seq, role, content, attachments, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (message_id, chat_id, seq, role, content, json.dumps(attachments or []), status, time.time()))
            self._conn.commit()
        return message_id

    def finish_message(self, message_id: str, *, content: str, parts: list, llm: list, status: str,
                       notice: str = "") -> None:
        self._run("UPDATE messages SET content = ?, parts = ?, llm = ?, status = ?, notice = ? WHERE id = ?",
                  (content, json.dumps(parts), json.dumps(llm), status, notice, message_id))

    def messages(self, chat_id: str) -> list[dict[str, Any]]:
        rows = self._run("SELECT * FROM messages WHERE chat_id = ? ORDER BY seq", (chat_id,))
        out = []
        for row in rows:
            item = dict(row)
            for key in ("parts", "attachments", "llm"):
                item[key] = json.loads(item[key])
            out.append(item)
        return out

    # ------------------------------------------------------------------ artifacts

    def create_artifact(self, chat_id: str, message_id: str, title: str, kind: str, language: str,
                        content: str) -> dict[str, Any]:
        artifact_id, now = new_id("art"), time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO artifacts (id, chat_id, message_id, title, kind, language, version, created_at, "
                "updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
                (artifact_id, chat_id, message_id, title, kind, language, now, now))
            self._conn.execute(
                "INSERT INTO artifact_versions (artifact_id, version, title, content, message_id, created_at) "
                "VALUES (?, 1, ?, ?, ?, ?)", (artifact_id, title, content, message_id, now))
            self._conn.commit()
        return self.get_artifact(artifact_id)

    def add_artifact_version(self, artifact_id: str, message_id: str, title: str, content: str) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            version = self._conn.execute("SELECT version FROM artifacts WHERE id = ?",
                                         (artifact_id,)).fetchone()[0] + 1
            self._conn.execute("UPDATE artifacts SET version = ?, title = ?, updated_at = ? WHERE id = ?",
                               (version, title, now, artifact_id))
            self._conn.execute(
                "INSERT INTO artifact_versions (artifact_id, version, title, content, message_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)", (artifact_id, version, title, content, message_id, now))
            self._conn.commit()
        return self.get_artifact(artifact_id, version)

    def get_artifact(self, artifact_id: str, version: int | None = None) -> dict[str, Any] | None:
        rows = self._run("SELECT * FROM artifacts WHERE id = ?", (artifact_id,))
        if not rows:
            return None
        artifact = dict(rows[0])
        latest = artifact["version"]
        wanted = latest if version is None else version
        versions = self._run("SELECT version, title, content, created_at FROM artifact_versions "
                             "WHERE artifact_id = ? AND version = ?", (artifact_id, wanted))
        if not versions:
            return None
        picked = dict(versions[0])
        return {"id": artifact["id"], "chat_id": artifact["chat_id"], "kind": artifact["kind"],
                "language": artifact["language"], "title": picked["title"], "content": picked["content"],
                "version": picked["version"], "latest_version": latest, "created_at": picked["created_at"]}
