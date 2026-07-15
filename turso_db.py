"""
Minimal sqlite3-compatible client for Turso's HTTP (Hrana-over-HTTP) API.

Built as a thin wrapper instead of depending on Turso's official Python SDKs
because, at the time this was written, those packages were either marked
"experimental / not production-grade" or lacked Windows support for local
development. This module only depends on `requests` and mimics just enough
of the stdlib `sqlite3` interface (Connection.cursor/execute/commit/rollback/
close, Cursor.execute/fetchone/fetchall/lastrowid, and dict()-able Row
objects) for database.py and app.py to use it as a drop-in replacement.

Transactions: each statement is sent to Turso individually and applied
immediately (SQLite's normal autocommit behavior for a single statement).
commit()/rollback() are safe no-ops here — this module does not implement
multi-statement atomicity across a request. That's an accepted simplification;
call sites that need "all or nothing" behavior across multiple statements
would need explicit BEGIN/COMMIT/ROLLBACK statements to get that from Turso.
"""

import base64
import sqlite3
import requests

_TIMEOUT = 15
_CONSTRAINT_MARKERS = ("UNIQUE constraint failed", "CHECK constraint failed", "FOREIGN KEY constraint failed", "NOT NULL constraint failed")


class TursoRow:
    """Mimics sqlite3.Row: supports row['col'], row[0], and dict(row)."""

    __slots__ = ("_cols", "_values")

    def __init__(self, cols, values):
        self._cols = cols
        self._values = values

    def __getitem__(self, key):
        if isinstance(key, str):
            return self._values[self._cols.index(key)]
        return self._values[key]

    def keys(self):
        return list(self._cols)

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __repr__(self):
        return f"TursoRow({dict(zip(self._cols, self._values))!r})"


def _to_arg(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    if isinstance(value, (bytes, bytearray)):
        return {"type": "blob", "base64": base64.b64encode(bytes(value)).decode("ascii")}
    return {"type": "text", "value": str(value)}


def _from_value(cell):
    if cell is None:
        return None
    t = cell.get("type")
    if t == "null":
        return None
    if t == "integer":
        return int(cell["value"])
    if t == "float":
        return float(cell["value"])
    if t == "blob":
        return base64.b64decode(cell["value"])
    return cell.get("value")


class TursoCursor:
    def __init__(self, conn):
        self._conn = conn
        self.lastrowid = None
        self.rowcount = -1
        self._rows = []
        self._pos = 0

    def execute(self, sql, params=()):
        result = self._conn._execute(sql, params)
        cols = [c["name"] for c in result.get("cols", [])]
        raw_rows = result.get("rows", [])
        self._rows = [TursoRow(cols, [_from_value(v) for v in r]) for r in raw_rows]
        self._pos = 0
        lrid = result.get("last_insert_rowid")
        self.lastrowid = int(lrid) if lrid is not None else None
        arc = result.get("affected_row_count")
        self.rowcount = int(arc) if arc is not None else -1
        return self

    def executemany(self, sql, seq_of_params):
        for params in seq_of_params:
            self.execute(sql, params)
        return self

    def fetchone(self):
        if self._pos >= len(self._rows):
            return None
        row = self._rows[self._pos]
        self._pos += 1
        return row

    def fetchall(self):
        remaining = self._rows[self._pos:]
        self._pos = len(self._rows)
        return remaining

    def fetchmany(self, size=1):
        remaining = self._rows[self._pos:self._pos + size]
        self._pos += len(remaining)
        return remaining

    def __iter__(self):
        return iter(self.fetchall())

    def close(self):
        pass


class TursoConnection:
    def __init__(self, database_url, auth_token):
        base = database_url.replace("libsql://", "https://", 1)
        if base.startswith("http://") is False and base.startswith("https://") is False:
            base = "https://" + base
        self._pipeline_url = base.rstrip("/") + "/v2/pipeline"
        self._auth_token = auth_token
        self._baton = None
        self.row_factory = None  # kept for API parity; rows are always TursoRow
        self._closed = False

    def _execute(self, sql, params):
        args = [_to_arg(p) for p in (params or ())]
        payload = {
            "baton": self._baton,
            "requests": [
                {"type": "execute", "stmt": {"sql": sql, "args": args}}
            ],
        }
        resp = requests.post(
            self._pipeline_url,
            json=payload,
            headers={"Authorization": f"Bearer {self._auth_token}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        self._baton = data.get("baton", self._baton)

        entry = data["results"][0]
        if entry.get("type") == "error":
            err = entry.get("error", {})
            message = err.get("message", str(err))
            # Raise the same exception type sqlite3 would, so existing
            # `except sqlite3.IntegrityError` handlers keep working unchanged.
            if any(marker in message for marker in _CONSTRAINT_MARKERS):
                raise sqlite3.IntegrityError(message)
            raise sqlite3.OperationalError(message)
        return entry["response"]["result"]

    def cursor(self):
        return TursoCursor(self)

    def execute(self, sql, params=()):
        c = self.cursor()
        c.execute(sql, params)
        return c

    def commit(self):
        # Each statement is already applied server-side; nothing to flush.
        pass

    def rollback(self):
        # No multi-statement transaction is held open to roll back.
        pass

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self._baton:
            try:
                requests.post(
                    self._pipeline_url,
                    json={"baton": self._baton, "requests": [{"type": "close"}]},
                    headers={"Authorization": f"Bearer {self._auth_token}"},
                    timeout=5,
                )
            except Exception:
                pass


def connect(database_url, auth_token):
    return TursoConnection(database_url, auth_token)
