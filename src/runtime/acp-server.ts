/**
 * ACP Server — Agent Client Protocol over stdio
 *
 * Exposes whipflow as an ACP-compatible tool so other agents (Cursor, etc.)
 * can call it via JSON-RPC 2.0 over stdin/stdout.
 *
 * Protocol: line-delimited JSON-RPC 2.0
 *   - Client writes requests to stdin
 *   - Server writes responses to stdout
 *   - Diagnostic/log messages go to stderr only
 *
 * Supported methods:
 *   initialize          — handshake
 *   tools/list          — list available tools
 *   tools/call          — execute a whipflow .whip file or inline source
 *   session/run         — run a whipflow session with a prompt
 *   ping                — liveness check
 */

import { parse, validate, execute } from '../index';
import { isSessionResult } from './types';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as readline from 'readline';

// ── Types ──────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcNotification = Omit<JsonRpcRequest, 'id'> & { id?: undefined };

// Standard JSON-RPC error codes
const ERR_PARSE         = -32700;
const ERR_INVALID_REQ   = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL      = -32603;

// ── Tools registry ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'whipflow_run_file',
    description:
      'Execute a whipflow .whip workflow file. Returns the session output(s).',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Absolute or relative path to the .whip file to execute.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'whipflow_run_source',
    description:
      'Execute inline whipflow source code (a .whip program string). Returns session output(s).',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The whipflow (.whip) source code to execute.',
        },
        filename: {
          type: 'string',
          description: 'Optional filename for diagnostics (default: "inline.whip").',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'whipflow_validate',
    description: 'Validate whipflow source code syntax without executing it.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The whipflow (.whip) source code to validate.',
        },
      },
      required: ['source'],
    },
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function send(obj: JsonRpcResponse | JsonRpcNotification): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id: number | string | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function err(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): void {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function log(msg: string): void {
  process.stderr.write(`[whipflow-acp] ${msg}\n`);
}

function formatErrors(errors: Array<{ message: string }>): string {
  return errors.map(e => `  ${e.message}`).join('\n');
}

function formatExecutionErrors(errors: Array<{ type: string; message: string }>): string {
  return errors.map(e => `  [${e.type}] ${e.message}`).join('\n');
}

// ── Tool handlers ──────────────────────────────────────────────────────────

async function handleRunSource(source: string): Promise<string> {
  const parsed = parse(source);
  if (parsed.errors.length > 0) {
    throw new Error('Parse errors:\n' + formatErrors(parsed.errors));
  }

  const validated = validate(parsed.program);
  if (validated.errors.length > 0) {
    throw new Error('Validation errors:\n' + formatErrors(validated.errors));
  }

  const result = await execute(parsed.program, {
    debug: false,
    traceExecution: false,
    logLevel: 'warn',
  });

  if (!result.success) {
    throw new Error(
      'Execution failed:\n' + formatExecutionErrors(result.errors)
    );
  }

  // Collect outputs
  const parts: string[] = [];

  for (const [name, value] of result.outputs.entries()) {
    if (isSessionResult(value)) {
      parts.push(`[${name}]\n${value.output}`);
    }
  }

  for (const [i, s] of result.sessionOutputs.entries()) {
    const label =
      result.sessionOutputs.length > 1 ? `session ${i + 1}` : 'output';
    parts.push(`[${label}]\n${s.output}`);
  }

  return parts.join('\n\n---\n\n') || '(no output)';
}

// ── Request dispatcher ─────────────────────────────────────────────────────

async function dispatch(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize': {
      ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'whipflow', version: '0.1.0' },
      });
      break;
    }

    case 'ping': {
      ok(id, { pong: true });
      break;
    }

    case 'tools/list': {
      ok(id, { tools: TOOLS });
      break;
    }

    case 'tools/call': {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      if (!p?.name) {
        err(id, ERR_INVALID_PARAMS, 'Missing tool name');
        return;
      }

      const args = p.arguments ?? {};

      try {
        switch (p.name) {
          case 'whipflow_run_file': {
            const file = args.file as string;
            if (!file) {
              err(id, ERR_INVALID_PARAMS, 'Missing required argument: file');
              return;
            }
            let source: string;
            try {
              source = readFileSync(file, 'utf-8');
            } catch {
              err(id, ERR_INVALID_PARAMS, `File not found: ${file}`);
              return;
            }
            const output = await handleRunSource(source);
            ok(id, {
              content: [{ type: 'text', text: output }],
            });
            break;
          }

          case 'whipflow_run_source': {
            const source = args.source as string;
            if (!source) {
              err(id, ERR_INVALID_PARAMS, 'Missing required argument: source');
              return;
            }
            const output = await handleRunSource(source);
            ok(id, {
              content: [{ type: 'text', text: output }],
            });
            break;
          }

          case 'whipflow_validate': {
            const source = args.source as string;
            if (!source) {
              err(id, ERR_INVALID_PARAMS, 'Missing required argument: source');
              return;
            }
            const parsed = parse(source);
            if (parsed.errors.length > 0) {
              ok(id, {
                content: [
                  {
                    type: 'text',
                    text: 'Invalid:\n' + formatErrors(parsed.errors),
                  },
                ],
                isError: true,
              });
              return;
            }
            const validated = validate(parsed.program);
            if (validated.errors.length > 0) {
              ok(id, {
                content: [
                  {
                    type: 'text',
                    text: 'Validation errors:\n' + formatErrors(validated.errors),
                  },
                ],
                isError: true,
              });
              return;
            }
            const warnings = validated.warnings.map(w => `  warning: ${w.message}`).join('\n');
            ok(id, {
              content: [
                {
                  type: 'text',
                  text: warnings ? `Valid (with warnings):\n${warnings}` : 'Valid',
                },
              ],
            });
            break;
          }

          default:
            err(id, ERR_METHOD_NOT_FOUND, `Unknown tool: ${p.name}`);
        }
      } catch (e: unknown) {
        err(id, ERR_INTERNAL, (e as Error).message ?? String(e));
      }
      break;
    }

    default:
      err(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────

export function startAcpServer(): void {
  log('ACP server starting (stdio transport)');

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      err(null, ERR_PARSE, 'Parse error: invalid JSON');
      return;
    }

    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      err(req.id ?? null, ERR_INVALID_REQ, 'Invalid Request');
      return;
    }

    dispatch(req).catch((e: unknown) => {
      log(`Unhandled error: ${e}`);
      err(req.id ?? null, ERR_INTERNAL, 'Internal error');
    });
  });

  rl.on('close', () => {
    log('stdin closed, shutting down');
    process.exit(0);
  });

  // Notify Cursor/MCP host that we're ready (optional — some hosts expect this)
  log('ready');
}
