#!/usr/bin/env python3
"""Mark confirmed StackChan camera history as transient without touching assets.

The migration is deliberately fail-closed: a historical attachment is eligible
only when its conversation record carries the fixed StackChan camera prompt or
the new exact source/class metadata. It marks the Visual Experience index and
archives only directly attached visual PetMemory rows. Conversation messages,
attachments, and unrelated memories remain untouched.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path


STACKCHAN_CAMERA_PROMPT = "花花通过实体身体的摄像头主动看了看现实环境。请直接告诉主人你看到了什么。"
STACKCHAN_CAMERA_SOURCE = "stackchan_camera"
EMBODIED_TRANSIENT_VISUAL_CLASS = "embodied_transient"
MEMORY_LEVELS = ("fact", "lesson", "project", "rules", "soul", "topic", "user")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sandbox",
        type=Path,
        default=Path.home() / ".local/share/vc-ai-pet/sandbox",
    )
    parser.add_argument("--apply", action="store_true", help="write the bounded migration")
    return parser.parse_args()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def is_confirmed_stackchan_message(message: dict) -> bool:
    if message.get("role") != "user":
        return False
    attachment = message.get("attachment") or {}
    exact_prompt = str(message.get("text") or "").strip() == STACKCHAN_CAMERA_PROMPT
    exact_metadata = (
        attachment.get("source") == STACKCHAN_CAMERA_SOURCE
        or attachment.get("visualClass") == EMBODIED_TRANSIENT_VISUAL_CLASS
        or message.get("source") == STACKCHAN_CAMERA_SOURCE
    )
    return exact_prompt or exact_metadata


def confirmed_attachments(conversation_path: Path) -> dict[str, str]:
    state = read_json(conversation_path)
    found: dict[str, str] = {}
    for message in state.get("messages", []):
        if not is_confirmed_stackchan_message(message):
            continue
        attachment_id = str((message.get("attachment") or {}).get("id") or "").strip()
        message_id = str(message.get("id") or "").strip()
        if attachment_id and message_id:
            found[attachment_id] = message_id
    return found


def open_db(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=5)
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def mark_visual_index(path: Path, attachment_ids: set[str], apply: bool) -> tuple[int, int]:
    if not attachment_ids:
        return 0, 0
    connection = open_db(path)
    try:
        placeholders = ",".join("?" for _ in attachment_ids)
        roots = int(
            connection.execute(
                f"SELECT COUNT(*) FROM visual_experiences WHERE attachment_id IN ({placeholders})",
                tuple(attachment_ids),
            ).fetchone()[0]
        )
        occurrences = int(
            connection.execute(
                f"SELECT COUNT(*) FROM visual_occurrences WHERE attachment_id IN ({placeholders})",
                tuple(attachment_ids),
            ).fetchone()[0]
        )
        if apply:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS visual_transient_attachments ("
                "attachment_id TEXT PRIMARY KEY, marked_at INTEGER NOT NULL)"
            )
            now = int(time.time() * 1000)
            connection.executemany(
                "INSERT OR IGNORE INTO visual_transient_attachments(attachment_id, marked_at) VALUES (?, ?)",
                ((attachment_id, now) for attachment_id in attachment_ids),
            )
            connection.commit()
        return roots, occurrences
    finally:
        connection.close()


def metadata_object(value: str | None) -> dict:
    try:
        parsed = json.loads(value or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def json_list(value: str | None) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
        return [str(item) for item in parsed] if isinstance(parsed, list) else []
    except (TypeError, ValueError):
        return []


def archive_direct_visual_memory(path: Path, attachment_ids: set[str], apply: bool) -> int:
    if not attachment_ids:
        return 0
    connection = open_db(path)
    try:
        provenance = connection.execute(
            "SELECT memory_id, source, evidence, source_ids, metadata "
            "FROM memory_provenance"
        ).fetchall()
        root_ids: set[str] = set()
        for memory_id, source, evidence, source_ids, metadata in provenance:
            metadata_value = metadata_object(metadata)
            if (
                source == "SYSTEM_EVENT"
                and evidence == "confirmed"
                and metadata_value.get("attachmentId") in attachment_ids
                and metadata_value.get("evidenceQuote") == STACKCHAN_CAMERA_PROMPT
            ):
                root_ids.add(str(memory_id))

        direct_ids = set(root_ids)
        for memory_id, source, _evidence, source_ids, metadata in provenance:
            if source != "VISUAL_OBSERVATION":
                continue
            metadata_value = metadata_object(metadata)
            source_id_values = set(json_list(source_ids))
            if metadata_value.get("attachmentId") in attachment_ids or source_id_values & root_ids:
                direct_ids.add(str(memory_id))

        if not direct_ids:
            return 0
        if not apply:
            placeholders = ",".join("?" for _ in direct_ids)
            active = 0
            for level in MEMORY_LEVELS:
                active += int(
                    connection.execute(
                        f"SELECT COUNT(*) FROM {level} WHERE id IN ({placeholders}) AND status = 'active'",
                        tuple(direct_ids),
                    ).fetchone()[0]
                )
            return active

        placeholders = ",".join("?" for _ in direct_ids)
        archived = 0
        now = int(time.time() * 1000)
        for level in MEMORY_LEVELS:
            rows = connection.execute(
                f"SELECT id FROM {level} WHERE id IN ({placeholders}) AND status = 'active'",
                tuple(direct_ids),
            ).fetchall()
            if not rows:
                continue
            connection.execute(
                f"UPDATE {level} SET status = 'archived', updated_at = ? "
                f"WHERE id IN ({placeholders}) AND status = 'active'",
                (now, *direct_ids),
            )
            archived += len(rows)
        connection.commit()
        return archived
    finally:
        connection.close()


def main() -> int:
    args = parse_args()
    sandbox = args.sandbox.expanduser().resolve()
    attachments = confirmed_attachments(sandbox / "conversation-store.json")
    attachment_ids = set(attachments)
    roots, occurrences = mark_visual_index(
        sandbox / "visual-experience.db",
        attachment_ids,
        args.apply,
    )
    archived = archive_direct_visual_memory(
        sandbox / "memory/pet-memory.db",
        attachment_ids,
        args.apply,
    )
    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "historicalStackchanImagesFound": len(attachment_ids),
        "visualRootsMarked": roots,
        "visualOccurrencesMarked": occurrences,
        "directVisualMemoryRowsArchived": archived,
        "attachmentIds": sorted(attachment_ids) if args.apply is False else None,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
