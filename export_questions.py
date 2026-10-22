#!/usr/bin/env python3
"""从 ebbinghaus-quiz/data/quiz.db 导出题库到 data/questions.json（一次性 / 可重复）。"""
from __future__ import annotations

import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.normpath(os.path.join(HERE, "..", "ebbinghaus-quiz", "data", "quiz.db"))
DEFAULT_OUT = os.path.join(HERE, "data", "questions.json")


def export(db_path: str = DEFAULT_DB, out_path: str = DEFAULT_OUT) -> int:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"找不到数据库: {db_path}")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, stem, options_json, answer, explanation, source_file,
                   qtype, tags, difficulty, raw_qtype, created_at
            FROM questions ORDER BY id
            """
        ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            opts = d.pop("options_json")
            if opts:
                try:
                    d["options"] = json.loads(opts)
                except json.JSONDecodeError:
                    d["options"] = None
            else:
                d["options"] = None
            items.append(d)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, separators=(",", ":"))
        return len(items)
    finally:
        conn.close()


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    n = export(db, out)
    print(f"导出 {n} 题 -> {out}")
