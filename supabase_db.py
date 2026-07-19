"""
sqlite3-compatible wrapper around psycopg2 for talking to Supabase Postgres.

The rest of the codebase (database.py, app.py) was written against sqlite3's
interface (Connection.cursor/execute/commit/close, Cursor.execute/fetchone/
fetchall/lastrowid, `?` placeholders, dict()-able Row objects). This module
mimics that surface on top of a real Postgres connection so call sites don't
need to know which driver is underneath.

Differences from sqlite3 that are bridged here:
- Placeholders: sqlite uses `?`, psycopg2 uses `%s` - translated on every
  execute().
- lastrowid: Postgres has no ROWID concept. Every table in this schema has
  a serial `id` primary key, so plain INSERT statements (without an existing
  RETURNING clause) get `RETURNING id` appended automatically and the
  returned value is exposed as cursor.lastrowid, mirroring sqlite3.
- Autocommit: the connection is opened in autocommit mode so each statement
  takes effect immediately, matching the per-statement-autocommit behavior
  the app was already built around (see turso_db.py). This also avoids
  Postgres's "current transaction is aborted" pitfall: a failed statement
  (e.g. a UNIQUE violation) doesn't poison later statements on the same
  connection.
- Exceptions: constraint violations are re-raised as sqlite3.IntegrityError
  so existing `except sqlite3.IntegrityError` call sites keep working.
"""

import re
import sqlite3

import psycopg2
import psycopg2.errorcodes

_INTEGRITY_SQLSTATES = {
    psycopg2.errorcodes.UNIQUE_VIOLATION,
    psycopg2.errorcodes.CHECK_VIOLATION,
    psycopg2.errorcodes.FOREIGN_KEY_VIOLATION,
    psycopg2.errorcodes.NOT_NULL_VIOLATION,
    psycopg2.errorcodes.RESTRICT_VIOLATION,
}

_INSERT_RE = re.compile(r"^\s*INSERT\b", re.IGNORECASE)
_RETURNING_RE = re.compile(r"\bRETURNING\b", re.IGNORECASE)
_PRAGMA_RE = re.compile(r"^\s*PRAGMA\b", re.IGNORECASE)


class SupabaseRow:
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
        return f"SupabaseRow({dict(zip(self._cols, self._values))!r})"


def _translate(sql):
    """sqlite `?` placeholders -> psycopg2 `%s`; auto-add RETURNING id to INSERTs."""
    sql = sql.replace("?", "%s")
    if _INSERT_RE.match(sql) and not _RETURNING_RE.search(sql):
        sql = sql.rstrip().rstrip(";") + " RETURNING id"
    return sql


class SupabaseCursor:
    def __init__(self, conn):
        self._conn = conn
        self.lastrowid = None
        self.rowcount = -1
        self._rows = []
        self._pos = 0

    def execute(self, sql, params=()):
        if _PRAGMA_RE.match(sql):
            # Postgres always enforces foreign keys; PRAGMA has no equivalent.
            self._rows = []
            self._pos = 0
            self.lastrowid = None
            self.rowcount = -1
            return self

        pg_sql = _translate(sql)
        cur = self._conn._raw.cursor()
        try:
            cur.execute(pg_sql, tuple(params) if params else None)
        except psycopg2.Error as e:
            sqlstate = getattr(e, "pgcode", None)
            message = str(e).strip()
            if sqlstate in _INTEGRITY_SQLSTATES:
                raise sqlite3.IntegrityError(message)
            raise sqlite3.OperationalError(message)

        if cur.description is not None:
            cols = [d[0] for d in cur.description]
            raw_rows = cur.fetchall()
            self._rows = [SupabaseRow(cols, list(r)) for r in raw_rows]
        else:
            self._rows = []
        self._pos = 0
        self.rowcount = cur.rowcount

        if _INSERT_RE.match(sql) and self._rows:
            self.lastrowid = self._rows[0]["id"]
            self._rows = []
        else:
            self.lastrowid = None

        cur.close()
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


class SupabaseConnection:
    def __init__(self, host, port, user, password, dbname):
        self._raw = psycopg2.connect(
            host=host, port=port, user=user, password=password, dbname=dbname,
        )
        self._raw.autocommit = True
        self.row_factory = None  # kept for API parity; rows are always SupabaseRow

    def cursor(self):
        return SupabaseCursor(self)

    def execute(self, sql, params=()):
        c = self.cursor()
        c.execute(sql, params)
        return c

    def commit(self):
        # Autocommit is on; each statement is already applied.
        pass

    def rollback(self):
        pass

    def close(self):
        self._raw.close()


def connect(host, port, user, password, dbname):
    return SupabaseConnection(host, port, user, password, dbname)
