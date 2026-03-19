/**
 * Custom Tools Loader
 *
 * Loads user-defined tool definitions from a directory (default: ~/.whipflow/tools/).
 * Each tool is a JSON file describing a command the AI can invoke.
 *
 * Tool definition file format (e.g., ~/.whipflow/tools/fetch-url.json):
 * {
 *   "name": "fetch-url",
 *   "description": "Fetch the content of a URL and return its text",
 *   "type": "bash",
 *   "command": "curl -sL --max-time 30 '{url}'",
 *   "parameters": {
 *     "url": "The URL to fetch"
 *   }
 * }
 *
 * Alternatively, for a script-based tool:
 * {
 *   "name": "run-cmd",
 *   "description": "Run a shell command and return its output",
 *   "type": "bash",
 *   "command": "{cmd}",
 *   "parameters": {
 *     "cmd": "The shell command to execute"
 *   }
 * }
 *
 * Config in .whipflow.json:
 * {
 *   "toolsDir": "~/.whipflow/tools",
 *   "tools": ["fetch-url", "run-cmd"]   // optional: only load specific tools
 * }
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

export interface CustomToolDefinition {
  /** Tool name (must be a valid identifier) */
  name: string;
  /** Human-readable description for prompt injection */
  description: string;
  /**
   * Type of tool implementation:
   * - "bash"   : a bash command template (use {param} placeholders)
   * - "script" : path to a script file to execute
   * - "prompt" : prompt-only guidance (no executable, just injected as instructions)
   */
  type: 'bash' | 'script' | 'prompt';
  /** Command template for type=bash, script path for type=script */
  command?: string;
  /** Parameter descriptions — shown in prompt to explain how to use the tool */
  parameters?: Record<string, string>;
  /** Usage example shown to the AI */
  example?: string;
}

export interface LoadedCustomTools {
  /** Tool names to add to --allowedTools (bash-backed tools get "bash" added) */
  toolNames: string[];
  /** Prompt sections describing how to use each custom tool */
  promptSections: string[];
}

const DEFAULT_TOOLS_DIR = join(homedir(), '.whipflow', 'tools');

/**
 * Resolve the tools directory from config.
 * Supports ~ expansion.
 */
function resolveToolsDir(toolsDir?: string): string {
  if (!toolsDir) return DEFAULT_TOOLS_DIR;
  if (toolsDir.startsWith('~/')) {
    return join(homedir(), toolsDir.slice(2));
  }
  return resolve(toolsDir);
}

/**
 * Load a single tool definition from a JSON file.
 * Returns null if the file is invalid.
 */
function loadToolFile(filePath: string): CustomToolDefinition | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const def = JSON.parse(raw) as CustomToolDefinition;
    if (!def.name || typeof def.name !== 'string') return null;
    if (!def.description || typeof def.description !== 'string') return null;
    if (!def.type || !['bash', 'script', 'prompt'].includes(def.type)) return null;
    return def;
  } catch {
    return null;
  }
}

/**
 * Build the prompt section for a single tool definition.
 */
function buildToolPromptSection(tool: CustomToolDefinition): string {
  let section = `### Tool: ${tool.name}\n`;
  section += `${tool.description}\n`;

  if (tool.type === 'bash' && tool.command) {
    section += `\nCommand template:\n\`\`\`bash\n${tool.command}\n\`\`\`\n`;
  } else if (tool.type === 'script' && tool.command) {
    section += `\nScript: \`${tool.command}\`\n`;
  }

  if (tool.parameters && Object.keys(tool.parameters).length > 0) {
    section += '\nParameters:\n';
    for (const [param, desc] of Object.entries(tool.parameters)) {
      section += `- \`{${param}}\`: ${desc}\n`;
    }
  }

  if (tool.example) {
    section += `\nExample:\n\`\`\`\n${tool.example}\n\`\`\`\n`;
  }

  return section;
}

/**
 * Load all custom tools from the tools directory.
 *
 * @param toolsDir  Override directory (default: ~/.whipflow/tools)
 * @param filter    Optional list of tool names to load (load all if not specified)
 * @returns         LoadedCustomTools with toolNames and promptSections
 */
export function loadCustomTools(
  toolsDir?: string,
  filter?: string[]
): LoadedCustomTools {
  const dir = resolveToolsDir(toolsDir);

  if (!existsSync(dir)) {
    return { toolNames: [], promptSections: [] };
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return { toolNames: [], promptSections: [] };
  }

  const toolNames: string[] = [];
  const promptSections: string[] = [];

  for (const file of files) {
    const tool = loadToolFile(join(dir, file));
    if (!tool) continue;

    // Apply name filter if specified
    if (filter && filter.length > 0 && !filter.includes(tool.name)) continue;

    toolNames.push(tool.name);
    promptSections.push(buildToolPromptSection(tool));
  }

  return { toolNames, promptSections };
}

/**
 * Get available tool names in the tools directory (for validation / listing).
 */
export function listAvailableTools(toolsDir?: string): string[] {
  const dir = resolveToolsDir(toolsDir);
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const tool = loadToolFile(join(dir, f));
        return tool?.name ?? null;
      })
      .filter((n): n is string => n !== null);
  } catch {
    return [];
  }
}

/**
 * Returns the default tools directory path.
 */
export function getDefaultToolsDir(): string {
  return DEFAULT_TOOLS_DIR;
}
