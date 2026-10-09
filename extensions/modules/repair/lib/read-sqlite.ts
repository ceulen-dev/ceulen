// read-sqlite — sqlite views for the wrapped read (OMP read-sqlite.ts +
// sqlite-reader.ts semantics on the repair selector grammar).
//
// Grammar (parsed from the selector AFTER the path stem resolves to a real
// sqlite file — see parseSqliteSelector):
//   db.sqlite                  → table list
//   db.sqlite:users            → schema + first 10 rows
//   db.sqlite:users:42         → row by rowid
//   db.sqlite:users:name=alice → row(s) by key equality (LIMIT 20)
//   db.sqlite:SELECT …         → read-only query (SELECT/WITH/PRAGMA only)
// Engine: node:sqlite DatabaseSync opened READ-ONLY per call (unflagged
// since Node 22.13 < the repo engines floor). Fallback seam: swap
// `openDatabase` if a runtime refuses (e.g. sqlite3 CLI).

import { closeSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Row cap for raw queries (OMP MAX_RAW_QUERY_ROWS, trimmed). */
export const MAX_RAW_QUERY_ROWS = 200;
/** Rows shown under a bare table view. */
export const TABLE_PREVIEW_ROWS = 10;
/** Row cap for key-lookups. */
export const KEY_LOOKUP_LIMIT = 20;

export type SqliteSelector =
  | { kind: "tables" }
  | { kind: "table"; table: string }
  | { kind: "rowid"; table: string; rowid: number }
  | { kind: "key"; table: string; key: string; value: string }
  | { kind: "query"; sql: string };

/**
 * Parse a sqlite sub-selector (everything after the file path). Exported for
 * tests. Empty → tables view. A numeric segment after a table is a rowid;
 * `key=value` is a key lookup; a leading `?` or a SELECT/WITH/PRAGMA head is
 * a raw query.
 */
export function parseSqliteSelector(selector: string | undefined): SqliteSelector {
  const trimmed = (selector ?? "").trim();
  if (!trimmed) return { kind: "tables" };
  // `?…` marks a query explicitly (the head guard still enforces read-only);
  // a bare SELECT/WITH/PRAGMA head is accepted uncannily.
  if (trimmed.startsWith("?")) return { kind: "query", sql: trimmed.slice(1).trim() };
  if (/^(select|with|pragma)\b/i.test(trimmed)) return { kind: "query", sql: trimmed };
  const parts = trimmed.split(":");
  const table = parts[0]!.trim();
  if (!table) throw new Error(`invalid sqlite selector "${trimmed}" — expected :table, :table:rowid, :table:key=value or :?SELECT`);
  if (parts.length === 1) return { kind: "table", table };
  const second = parts.slice(1).join(":").trim();
  const rowid = /^\d+$/.exec(second);
  if (rowid) return { kind: "rowid", table, rowid: Number(second) };
  const kv = /^([A-Za-z_][\w]*)=(.*)$/s.exec(second);
  if (kv) return { kind: "key", table, key: kv[1]!, value: kv[2]!.replace(/^"(.*)"$/s, "$1") };
  throw new Error(`invalid sqlite selector "${second}" — use :${table}:<rowid>, :${table}:<key>=<value>, or :?SELECT …`);
}

/** Sniff: first 16 bytes are the SQLite magic header. Reads ONLY those 16
 *  bytes (a whole-file read parked multi-GB databases in memory for a sniff). */
export function isSqliteFile(absPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(absPath, "r");
    const head = Buffer.alloc(16);
    const read = readSync(fd, head, 0, 16, 0);
    return read >= 16 && head.equals(Buffer.from("SQLite format 3\0", "utf8"));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Quote an SQL identifier (double the embedded quotes). */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** One row → aligned key/value lines (repo read style, `—` for null). */
function renderRow(row: Record<string, unknown>, columns: string[]): string {
  return columns.map((c) => `${c}: ${row[c] === null || row[c] === undefined ? "—" : String(row[c])}`).join("\n");
}

/** Rows → aligned text table. */
function renderRows(columns: string[], rows: Record<string, unknown>[]): string {
  const cells = rows.map((r) => columns.map((c) => (r[c] === null || r[c] === undefined ? "—" : String(r[c] ?? ""))));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)));
  const line = (parts: string[]) => parts.map((p, i) => p.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(columns), line(widths.map((w) => "─".repeat(w))), ...cells.map(line)].join("\n");
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<Record<string, unknown>>).map(
    (c) => String(c.name),
  );
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number };
  return Number(row.n);
}

/** The single seam for tests (a runtime without node:sqlite can swap a CLI
 *  driver in here). Opens the db READ-ONLY; caller closes. */
export function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** Execute a parsed selector against the db. Returns model-facing text. */
export function executeSqliteView(db: DatabaseSync, sel: SqliteSelector, displayPath: string): string {
  switch (sel.kind) {
    case "tables": {
      const names = tableNames(db);
      if (names.length === 0) return `${displayPath} — no tables.`;
      const parts = names.map((name) => {
        const cols = columnsOf(db, name);
        return `${name}  ·  ${countRows(db, name)} rows  ·  ${cols.join(", ")}`;
      });
      return `${displayPath} — ${names.length} table(s)\n${parts.join("\n")}`;
    }
    case "table": {
      const names = tableNames(db);
      if (!names.includes(sel.table)) {
        return `no table "${sel.table}" in ${displayPath} — tables: ${names.join(", ") || "(none)"}`;
      }
      const cols = columnsOf(db, sel.table);
      const info = db.prepare(`PRAGMA table_info(${quoteIdent(sel.table)})`).all() as Array<Record<string, unknown>>;
      const schema = info
        .map((c) => `  ${c.name} ${c.type || "ANY"}${Number(c.pk) ? " PRIMARY KEY" : ""}${Number(c.notnull) ? " NOT NULL" : ""}`)
        .join("\n");
      const rows = db
        .prepare(`SELECT * FROM ${quoteIdent(sel.table)} LIMIT ${TABLE_PREVIEW_ROWS}`)
        .all() as Array<Record<string, unknown>>;
      const total = countRows(db, sel.table);
      const footer = total > rows.length ? `\n[${rows.length} of ${total} rows — query with :${sel.table}:<rowid> or :?SELECT]` : "";
      return `${displayPath} : ${sel.table} — ${total} rows\n${schema}\n\n${rows.length ? renderRows(cols, rows) : "(empty)"}${footer}`;
    }
    case "rowid": {
      const cols = columnsOf(db, sel.table);
      const row = db.prepare(`SELECT * FROM ${quoteIdent(sel.table)} WHERE rowid = ?`).get(sel.rowid) as
        | Record<string, unknown>
        | undefined;
      if (!row) return `no row with rowid ${sel.rowid} in ${displayPath} : ${sel.table}`;
      return `${displayPath} : ${sel.table} : rowid ${sel.rowid}\n${renderRow(row, cols)}`;
    }
    case "key": {
      const cols = columnsOf(db, sel.table);
      if (!cols.includes(sel.key)) {
        return `no column "${sel.key}" in ${displayPath} : ${sel.table} — columns: ${cols.join(", ")}`;
      }
      const rows = db
        .prepare(`SELECT * FROM ${quoteIdent(sel.table)} WHERE ${quoteIdent(sel.key)} = ? LIMIT ${KEY_LOOKUP_LIMIT}`)
        .all(sel.value) as Array<Record<string, unknown>>;
      if (rows.length === 0) return `no rows where ${sel.key} = "${sel.value}" in ${displayPath} : ${sel.table}`;
      const body = rows.map((r) => renderRow(r, cols)).join("\n\n---\n\n");
      const footer = rows.length >= KEY_LOOKUP_LIMIT ? `\n[stopped at ${KEY_LOOKUP_LIMIT} rows — narrow the key]` : "";
      return `${displayPath} : ${sel.table} : ${sel.key}="${sel.value}" — ${rows.length} row(s)\n${body}${footer}`;
    }
    case "query": {
      const head = sel.sql.trim().slice(0, 6).toUpperCase();
      if (!/^(SELECT|WITH|PRAGMA)/.test(head)) {
        throw new Error(`only read-only queries (SELECT/WITH/PRAGMA) — got "${sel.sql.slice(0, 40)}". Use bash for writes.`);
      }
      // Bounded iteration (F8): never materialize more than cap+1 rows.
      // Column names come from the first row (F2) — stmt.columns() is
      // Node >=23.11 and TypeErrors on the 22.x engines floor.
      const collected: Record<string, unknown>[] = [];
      let overflow = false;
      for (const row of db.prepare(sel.sql).iterate()) {
        if (collected.length >= MAX_RAW_QUERY_ROWS) {
          overflow = true;
          break;
        }
        collected.push(row as Record<string, unknown>);
      }
      const columns = collected.length ? Object.keys(collected[0]!) : [];
      const footer = overflow
        ? `\n[showing ${collected.length} of ${collected.length}+ rows — add LIMIT to narrow the query]`
        : "";
      const total = overflow ? `${collected.length}+` : String(collected.length);
      return `${displayPath} : query — ${total} row(s)\n${collected.length ? renderRows(columns, collected) : "(no rows)"}${footer}`;
    }
  }
}

/** Full read view for a sqlite path + selector. Opens/closes the db. */
export function readSqlite(absPath: string, selector: string | undefined, displayPath: string): string {
  const sel = parseSqliteSelector(selector);
  const db = openDatabase(absPath);
  try {
    return executeSqliteView(db, sel, displayPath);
  } finally {
    db.close();
  }
}
