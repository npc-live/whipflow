/**
 * Generic CLI Provider
 * Runs any AI CLI tool (claude, opencode, aider, etc.) as a session provider.
 *
 * Provider config comes from (in priority order):
 *   1. .whipflow.json  in the current working directory
 *   2. ~/.config/whipflow/providers.json  (global user config)
 *   3. Built-in presets
 *   4. "custom:bin [args...]"  shorthand
 */

import { spawn, execFileSync } from 'child_process';

function resolveRealPath(bin: string): string {
  try {
    return execFileSync('which', [bin], { encoding: 'utf-8' }).trim();
  } catch {
    return bin;
  }
}
import { SessionResult, SessionSpec, RuntimeConfig, isSessionResult } from './types';
import { resolveProviderConfig } from './provider-config';
import { RESET, BOLD, BLUE, CYAN, DIM, GREEN, YELLOW } from './ansi';

function providerTag(name: string): string {
  return `${BOLD}${BLUE}[${name.toUpperCase()}]${RESET}`;
}

/**
 * Per-CLI invocation config (also used in provider-config.ts)
 */
export interface CliConfig {
  /** Display name shown in logs */
  name: string;
  /** Binary to invoke */
  bin: string;
  /** How to pass the prompt: 'stdin' | 'arg' */
  promptMode: 'stdin' | 'arg';
  /** Args prepended before the prompt (promptMode='arg') */
  args?: string[];
  /** Args passed alongside the binary (promptMode='stdin') */
  stdinArgs?: string[];
  /** Timeout ms (default 30 min) */
  timeout?: number;
  /**
   * Output format expected from the CLI.
   * 'text'        — plain text, returned as-is  (default)
   * 'stream-json' — newline-delimited JSON (Claude Code agentic mode);
   *                 the final result is extracted from the type:"result" message
   */
  outputFormat?: 'text' | 'stream-json';
  /**
   * When true, pass spec.prompt directly to the CLI without wrapping it in
   * the full agent prompt (no system prompt, tools, skills, context injection).
   * Useful for non-AI providers like curl/fetch where the prompt IS the argument.
   */
  rawPrompt?: boolean;
}

/** Strip ANSI escape codes */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Parse Claude Code's --output-format stream-json stdout.
 * Returns the final result text from the type:"result" message.
 * Throws if the session ended with an error.
 */
function parseStreamJson(stdout: string): string {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'result') {
        if (msg.is_error) throw new Error(`Claude Code session error: ${msg.result ?? 'unknown'}`);
        return (msg.result as string) ?? '';
      }
    } catch (e) {
      if (e instanceof SyntaxError) continue; // incomplete line — skip
      throw e;
    }
  }
  // Fallback: no result message found (e.g. provider doesn't emit one)
  return stdout.trim();
}

/**
 * Display a single stream-json message line to stderr.
 * Shows assistant text and tool calls as they arrive.
 */
function displayStreamJsonLine(line: string, tag: string): void {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'assistant') {
      for (const block of (msg.message?.content ?? []) as any[]) {
        if (block.type === 'text' && block.text) {
          process.stderr.write(`${tag} ${DIM}${block.text.trimEnd()}${RESET}\n`);
        } else if (block.type === 'tool_use') {
          process.stderr.write(`${tag} ${YELLOW}⚙ ${block.name}${RESET} ${DIM}${JSON.stringify(block.input)}${RESET}\n`);
        }
      }
    } else if (msg.type === 'result') {
      const cost = msg.total_cost_usd != null ? ` · $${msg.total_cost_usd.toFixed(4)}` : '';
      const turns = msg.num_turns != null ? ` · ${msg.num_turns} turn(s)` : '';
      process.stderr.write(`${tag} ${GREEN}✓ done${RESET} ${DIM}(${msg.duration_ms}ms${turns}${cost})${RESET}\n`);
    }
  } catch {
    // not valid JSON yet — partial line, ignore
  }
}

/**
 * Execute a session via a CLI subprocess.
 * extraArgs are appended to the spawn args (e.g. --allowedTools bash,read).
 */
async function runCli(cfg: CliConfig, prompt: string, extraArgs: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const baseArgs = cfg.promptMode === 'arg'
      ? [...(cfg.args ?? []), prompt]
      : [...(cfg.stdinArgs ?? []), ...extraArgs];

    const tag = providerTag(cfg.name);
    const resolvedBin = resolveRealPath(cfg.bin);
    console.log(`${tag} ${CYAN}▶ ${resolvedBin} ${baseArgs.join(' ')}${RESET}`);

    // Strip CLAUDECODE so nested claude invocations aren't blocked by the
    // "cannot be launched inside another Claude Code session" guard.
    const childEnv = { ...process.env };
    delete childEnv['CLAUDECODE'];

    const child = spawn(cfg.bin, baseArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      env: childEnv,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;
    // Line buffer for stream-json: chunks may split across JSON boundaries
    let lineBuffer = '';

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.removeAllListeners();
        try { child.kill('SIGTERM'); } catch (_) {}
        fn();
      }
    };

    const timer = setTimeout(
      () => settle(() => reject(new Error(`${cfg.name} timed out`))),
      cfg.timeout ?? 1800000
    );

    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdoutChunks.push(chunk);

      if (cfg.outputFormat === 'stream-json') {
        // Buffer until we have complete lines, then display each
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) displayStreamJsonLine(line, tag);
      } else {
        const clean = stripAnsi(chunk).trimEnd();
        if (clean) process.stderr.write(`${tag} ${DIM}${clean}${RESET}\n`);
      }
    });

    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stderrChunks.push(chunk);
      // Surface stderr live so errors are visible immediately
      process.stderr.write(`${tag} ${DIM}${chunk.trimEnd()}${RESET}\n`);
    });

    child.on('error', (err) => {
      settle(() => reject(new Error(`Failed to spawn ${cfg.bin}: ${err.message}`)));
    });

    child.on('close', (code) => {
      settle(() => {
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        if (code !== 0) {
          reject(new Error(`${cfg.bin} exited with code ${code}: ${stderr.trim()}`));
        } else {
          if (cfg.outputFormat !== 'stream-json') {
            console.log(`${tag} ${GREEN}✓ done${RESET}`);
          }
          const result = cfg.outputFormat === 'stream-json'
            ? parseStreamJson(stdout)
            : stripAnsi(stdout).trim();
          resolve(result);
        }
      });
    });

    if (cfg.promptMode === 'stdin') {
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (err) {
        settle(() => reject(new Error(`Failed to write stdin: ${err}`)));
      }
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Build the full prompt to send to the CLI, prepending agent system prompt,
 * tool instructions, skill prompts, and context variables.
 */
function buildPrompt(
  spec: SessionSpec,
  enableTools: boolean,
  allowedTools?: string[],
  skillPrompts?: string[]
): string {
  let prompt = '';

  if (spec.agent?.prompt) {
    prompt += `${spec.agent.prompt}\n\n`;
  }

  if (enableTools && allowedTools && allowedTools.length > 0) {
    prompt += `## Available Tools\n\nYou have access to the following tools:\n`;
    prompt += allowedTools.map(t => `- ${t}`).join('\n');
    prompt += `\n\nUse these tools proactively to accomplish the task. After using tools, summarize what you did.\n\n`;
  }

  if (skillPrompts && skillPrompts.length > 0) {
    prompt += '## Skills and Knowledge\n\n';
    prompt += skillPrompts.join('\n\n---\n\n');
    prompt += '\n\n';
  }

  prompt += `## Task\n\n${spec.prompt}\n\n`;

  if (spec.context?.variables) {
    const entries = Object.entries(spec.context.variables);
    if (entries.length > 0) {
      prompt += '## Context\n\n';
      for (const [key, value] of entries) {
        prompt += `### ${key}\n`;
        if (typeof value === 'string') {
          prompt += `${value}\n\n`;
        } else if (isSessionResult(value)) {
          prompt += `${value.output}\n\n`;
        } else {
          prompt += `${JSON.stringify(value, null, 2)}\n\n`;
        }
      }
    }
  }

  return prompt;
}

/**
 * Generic CLI Provider — resolves config from provider-config.ts
 */
export class CliProvider {
  private cfg: CliConfig;

  constructor(provider: string) {
    const cfg = resolveProviderConfig(provider);
    if (!cfg) {
      throw new Error(
        `Unknown provider: "${provider}". ` +
        `Add it to .whipflow.json or ~/.config/whipflow/providers.json`
      );
    }
    this.cfg = cfg;
  }

  get providerName(): string {
    return this.cfg.name;
  }

  async executeSession(
    spec: SessionSpec,
    _config: RuntimeConfig,
    enableTools: boolean = false,
    allowedTools?: string[],
    skillPrompts?: string[]
  ): Promise<SessionResult> {
    const startTime = Date.now();
    const tag = providerTag(this.cfg.name);

    console.log(`${tag} ${CYAN}starting session${RESET}`);

    // rawPrompt: skip full agent prompt wrapping, pass spec.prompt directly
    const prompt = this.cfg.rawPrompt
      ? spec.prompt
      : buildPrompt(spec, enableTools, allowedTools, skillPrompts);

    // For stream-json (agentic) mode, pass allowed tools to the CLI so it can
    // use them without interactive permission prompts.
    const extraArgs: string[] = [];
    if (this.cfg.outputFormat === 'stream-json' && allowedTools && allowedTools.length > 0) {
      extraArgs.push('--allowedTools', allowedTools.join(','));
    }

    const output = await runCli(this.cfg, prompt, extraArgs);

    console.log(`${tag} ${GREEN}session complete${RESET} ${DIM}(${Date.now() - startTime}ms)${RESET}`);

    return {
      output,
      metadata: {
        model: this.cfg.name,
        duration: Date.now() - startTime,
      },
    };
  }
}

/**
 * Create a CliProvider. Returns null if provider string is unresolvable.
 */
export function createCliProvider(provider: string): CliProvider | null {
  try {
    return new CliProvider(provider);
  } catch {
    return null;
  }
}
