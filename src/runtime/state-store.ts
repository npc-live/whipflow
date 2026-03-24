/**
 * StateStore - SQLite-backed persistence for whipflow execution state
 * Enables session-level resume on interruption or failure
 */

import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { SessionResult } from './types';

export interface RunRecord {
  id: number;
  filePath: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  errorMsg: string | null;
}

export interface SessionRecord {
  id: number;
  runId: number;
  sessionIndex: number;
  prompt: string;
  output: string;
  model: string;
  durationMs: number;
  tokensUsed: number | null;
  toolCallsJson: string | null;
  variablesJson: string;
  completedAt: number;
}

export class StateStore {
  private db: Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path   TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        error_msg   TEXT
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        session_index   INTEGER NOT NULL,
        prompt          TEXT    NOT NULL DEFAULT '',
        output          TEXT    NOT NULL,
        model           TEXT    NOT NULL,
        duration_ms     INTEGER NOT NULL,
        tokens_used     INTEGER,
        tool_calls_json TEXT,
        variables_json  TEXT    NOT NULL,
        completed_at    INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_inputs (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        var_name TEXT    NOT NULL,
        answer   TEXT    NOT NULL,
        UNIQUE(run_id, var_name)
      )
    `);
    // Migrate existing DBs that predate the prompt column
    const cols = (this.db.prepare("PRAGMA table_info(sessions)").all() as any[]).map(c => c.name);
    if (!cols.includes('prompt')) {
      this.db.run("ALTER TABLE sessions ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
    }
  }

  startRun(filePath: string): number {
    const stmt = this.db.prepare(
      'INSERT INTO runs (file_path, status, started_at) VALUES (?, ?, ?) RETURNING id'
    );
    const row = stmt.get(filePath, 'running', Date.now()) as { id: number };
    return row.id;
  }

  recordSession(
    runId: number,
    sessionIndex: number,
    prompt: string,
    result: SessionResult,
    variables: Record<string, unknown>
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions
        (run_id, session_index, prompt, output, model, duration_ms, tokens_used, tool_calls_json, variables_json, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      runId,
      sessionIndex,
      prompt,
      result.output,
      result.metadata.model,
      result.metadata.duration,
      result.metadata.tokensUsed ?? null,
      result.metadata.toolCalls ? JSON.stringify(result.metadata.toolCalls) : null,
      JSON.stringify(variables),
      Date.now()
    );
  }

  completeRun(runId: number): void {
    this.db.run(
      'UPDATE runs SET status = ?, finished_at = ? WHERE id = ?',
      'completed',
      Date.now(),
      runId
    );
  }

  failRun(runId: number, errorMsg: string): void {
    this.db.run(
      'UPDATE runs SET status = ?, finished_at = ?, error_msg = ? WHERE id = ?',
      'failed',
      Date.now(),
      errorMsg,
      runId
    );
  }

  findIncompleteRun(filePath: string): RunRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, file_path, status, started_at, finished_at, error_msg
      FROM runs
      WHERE file_path = ? AND status IN ('running', 'failed')
      ORDER BY id DESC
      LIMIT 1
    `);
    const row = stmt.get(filePath) as any;
    if (!row) return null;
    return this.rowToRunRecord(row);
  }

  getCompletedSessions(runId: number): SessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, run_id, session_index, prompt, output, model, duration_ms, tokens_used, tool_calls_json, variables_json, completed_at
      FROM sessions
      WHERE run_id = ?
      ORDER BY session_index ASC
    `);
    return (stmt.all(runId) as any[]).map(row => this.rowToSessionRecord(row));
  }

  saveUserInput(runId: number, varName: string, answer: string): void {
    this.db.run(
      'INSERT INTO user_inputs (run_id, var_name, answer) VALUES (?, ?, ?) ON CONFLICT(run_id, var_name) DO UPDATE SET answer = excluded.answer',
      runId, varName, answer
    );
  }

  getUserInputs(runId: number): Record<string, string> {
    const rows = this.db.prepare('SELECT var_name, answer FROM user_inputs WHERE run_id = ?').all(runId) as { var_name: string; answer: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.var_name] = row.answer;
    return result;
  }

  deleteRun(runId: number): void {
    this.db.run('DELETE FROM runs WHERE id = ?', runId);
  }

  cleanRuns(filePath: string | null): { runsDeleted: number } {
    if (filePath !== null) {
      const stmt = this.db.prepare('DELETE FROM runs WHERE file_path = ?');
      const result = stmt.run(filePath);
      return { runsDeleted: Number(result.changes) };
    } else {
      const result = this.db.run('DELETE FROM runs');
      return { runsDeleted: Number(result.changes) };
    }
  }

  getRecentRuns(filePath: string | null, limit: number): RunRecord[] {
    let stmt;
    let rows: any[];
    if (filePath !== null) {
      stmt = this.db.prepare(`
        SELECT id, file_path, status, started_at, finished_at, error_msg
        FROM runs
        WHERE file_path = ?
        ORDER BY id DESC
        LIMIT ?
      `);
      rows = stmt.all(filePath, limit) as any[];
    } else {
      stmt = this.db.prepare(`
        SELECT id, file_path, status, started_at, finished_at, error_msg
        FROM runs
        ORDER BY id DESC
        LIMIT ?
      `);
      rows = stmt.all(limit) as any[];
    }
    return rows.map(row => this.rowToRunRecord(row));
  }

  getSessionCount(runId: number): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE run_id = ?');
    const row = stmt.get(runId) as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }

  private rowToRunRecord(row: any): RunRecord {
    return {
      id: row.id,
      filePath: row.file_path,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorMsg: row.error_msg,
    };
  }

  private rowToSessionRecord(row: any): SessionRecord {
    return {
      id: row.id,
      runId: row.run_id,
      sessionIndex: row.session_index,
      prompt: row.prompt ?? '',
      output: row.output,
      model: row.model,
      durationMs: row.duration_ms,
      tokensUsed: row.tokens_used,
      toolCallsJson: row.tool_calls_json,
      variablesJson: row.variables_json,
      completedAt: row.completed_at,
    };
  }
}
