/**
 * Tool Calling Support for whipflow
 * Enables AI models to call functions/tools during execution
 */

import { RuntimeValue } from './types';
import { RESET, BOLD, MAGENTA, GREEN, RED, DIM, YELLOW } from './ansi';

/**
 * Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  handler: (args: Record<string, any>) => Promise<RuntimeValue> | RuntimeValue;
}

/**
 * Tool parameter definition
 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
}

/**
 * Tool call result
 */
export interface ToolCallResult {
  name: string;
  arguments: Record<string, any>;
  result: RuntimeValue;
}

/**
 * Tool execution log entry
 */
export interface ToolExecutionLog {
  name: string;
  arguments: Record<string, any>;
  result: RuntimeValue | null;
  error?: Error;
  timestamp: number;
  duration: number;
}

/**
 * Tool execution event listener
 */
export type ToolExecutionListener = (event: ToolExecutionLog) => void;

/**
 * Built-in tools
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'calculate',
    description: 'Perform mathematical calculations. Supports +, -, *, /, **, sqrt, abs, etc.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Mathematical expression to evaluate (e.g., "2 + 2", "sqrt(16)", "10 ** 2")',
        },
      },
      required: ['expression'],
    },
    handler: async (args) => {
      const expr = args.expression as string;
      try {
        // Safe eval using Function constructor with Math context
        const result = Function(
          'Math',
          `"use strict"; return ${expr.replace(/\b(sqrt|abs|pow|sin|cos|tan|log|exp|floor|ceil|round)\b/g, 'Math.$1')}`
        )(Math);
        return result;
      } catch (error) {
        throw new Error(`Calculation error: ${error}`);
      }
    },
  },
  {
    name: 'get_current_time',
    description: 'Get the current date and time',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          description: 'Format: "iso" (ISO 8601), "unix" (timestamp), or "readable" (human-readable)',
          enum: ['iso', 'unix', 'readable'],
        },
      },
    },
    handler: async (args) => {
      const format = (args.format as string) || 'iso';
      const now = new Date();

      switch (format) {
        case 'iso':
          return now.toISOString();
        case 'unix':
          return Math.floor(now.getTime() / 1000);
        case 'readable':
          return now.toLocaleString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
        default:
          return now.toISOString();
      }
    },
  },
  {
    name: 'random_number',
    description: 'Generate a random number',
    parameters: {
      type: 'object',
      properties: {
        min: {
          type: 'number',
          description: 'Minimum value (inclusive)',
        },
        max: {
          type: 'number',
          description: 'Maximum value (inclusive)',
        },
        integer: {
          type: 'boolean',
          description: 'Whether to return an integer (default: true)',
        },
      },
      required: ['min', 'max'],
    },
    handler: async (args) => {
      const min = args.min as number;
      const max = args.max as number;
      const integer = args.integer !== false;

      const random = Math.random() * (max - min) + min;
      return integer ? Math.floor(random) : random;
    },
  },
  {
    name: 'string_operations',
    description: 'Perform string operations like uppercase, lowercase, reverse, length, etc.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to process',
        },
        operation: {
          type: 'string',
          description: 'Operation to perform',
          enum: ['uppercase', 'lowercase', 'reverse', 'length', 'trim', 'capitalize'],
        },
      },
      required: ['text', 'operation'],
    },
    handler: async (args) => {
      const text = args.text as string;
      const operation = args.operation as string;

      switch (operation) {
        case 'uppercase':
          return text.toUpperCase();
        case 'lowercase':
          return text.toLowerCase();
        case 'reverse':
          return text.split('').reverse().join('');
        case 'length':
          return text.length;
        case 'trim':
          return text.trim();
        case 'capitalize':
          return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
        default:
          return text;
      }
    },
  },
  {
    name: 'read',
    description: 'Read content from a file',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to read from',
        },
        encoding: {
          type: 'string',
          description: 'File encoding (default: utf-8)',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const fs = await import('fs/promises');
      const path = args.path as string;
      const encoding = (args.encoding as BufferEncoding) || 'utf-8';

      try {
        const content = await fs.readFile(path, encoding);
        return { success: true, content, path };
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
          path
        };
      }
    },
  },
  {
    name: 'write',
    description: 'Write content to a file',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to write to',
        },
        content: {
          type: 'string',
          description: 'Content to write',
        },
        encoding: {
          type: 'string',
          description: 'File encoding (default: utf-8)',
        },
        append: {
          type: 'boolean',
          description: 'Whether to append to existing file (default: false)',
        },
      },
      required: ['path', 'content'],
    },
    handler: async (args) => {
      const fs = await import('fs/promises');
      const path = args.path as string;
      const content = args.content as string;
      const encoding = (args.encoding as BufferEncoding) || 'utf-8';
      const append = args.append as boolean || false;

      try {
        if (append) {
          await fs.appendFile(path, content, encoding);
        } else {
          await fs.writeFile(path, content, encoding);
        }
        return {
          success: true,
          path,
          bytes: Buffer.byteLength(content, encoding),
          mode: append ? 'append' : 'write'
        };
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
          path
        };
      }
    },
  },
  {
    name: 'bash',
    description: 'Execute bash/shell commands. SECURITY WARNING: Only use with trusted commands.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (optional)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['command'],
    },
    handler: async (args) => {
      const cp = await import('child_process');
      const command = args.command as string;
      const cwd = args.cwd as string | undefined;
      const timeout = (args.timeout as number) || 30000;

      try {
        const output = cp.execSync(command, {
          cwd: cwd || process.cwd(),
          timeout,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        });
        return {
          success: true,
          output: output.trim(),
          command
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          stderr: error.stderr ? error.stderr.toString() : '',
          command
        };
      }
    },
  },
  {
    name: 'edit',
    description: 'Edit file content by reading, transforming, and writing back',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to edit',
        },
        operation: {
          type: 'string',
          description: 'Edit operation: replace, insert, append, prepend',
          enum: ['replace', 'insert', 'append', 'prepend'],
        },
        search: {
          type: 'string',
          description: 'Text to search for (required for replace/insert)',
        },
        content: {
          type: 'string',
          description: 'New content to insert',
        },
        encoding: {
          type: 'string',
          description: 'File encoding (default: utf-8)',
        },
      },
      required: ['path', 'operation', 'content'],
    },
    handler: async (args) => {
      const fs = await import('fs/promises');
      const path = args.path as string;
      const operation = args.operation as string;
      const search = args.search as string | undefined;
      const content = args.content as string;
      const encoding = (args.encoding as BufferEncoding) || 'utf-8';

      try {
        // Read current content
        let fileContent = await fs.readFile(path, encoding);
        let newContent: string;

        switch (operation) {
          case 'replace':
            if (!search) {
              throw new Error('search parameter required for replace operation');
            }
            newContent = fileContent.replace(search, content);
            break;

          case 'insert':
            if (!search) {
              throw new Error('search parameter required for insert operation');
            }
            newContent = fileContent.replace(search, search + content);
            break;

          case 'append':
            newContent = fileContent + content;
            break;

          case 'prepend':
            newContent = content + fileContent;
            break;

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }

        // Write back
        await fs.writeFile(path, newContent, encoding);

        return {
          success: true,
          path,
          operation,
          originalLength: fileContent.length,
          newLength: newContent.length,
          changed: fileContent !== newContent
        };
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
          path,
          operation
        };
      }
    },
  },
];

/**
 * Tool registry
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private executionLog: ToolExecutionLog[] = [];
  private listeners: ToolExecutionListener[] = [];
  private loggingEnabled: boolean = true;

  constructor() {
    // Register built-in tools
    for (const tool of BUILTIN_TOOLS) {
      this.register(tool);
    }
  }

  /**
   * Register a tool
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tools
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Register an execution listener
   */
  onExecute(listener: ToolExecutionListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove an execution listener
   */
  offExecute(listener: ToolExecutionListener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  /**
   * Enable or disable logging
   */
  setLogging(enabled: boolean): void {
    this.loggingEnabled = enabled;
  }

  /**
   * Get execution log
   */
  getExecutionLog(): ToolExecutionLog[] {
    return [...this.executionLog];
  }

  /**
   * Clear execution log
   */
  clearLog(): void {
    this.executionLog = [];
  }

  /**
   * Get execution statistics
   */
  getStatistics() {
    const totalCalls = this.executionLog.length;
    const successfulCalls = this.executionLog.filter(e => !e.error).length;
    const failedCalls = this.executionLog.filter(e => e.error).length;

    const averageDuration = totalCalls > 0
      ? this.executionLog.reduce((sum, e) => sum + e.duration, 0) / totalCalls
      : 0;

    const toolUsage: Record<string, number> = {};
    for (const entry of this.executionLog) {
      toolUsage[entry.name] = (toolUsage[entry.name] || 0) + 1;
    }

    return {
      totalCalls,
      successfulCalls,
      failedCalls,
      averageDuration,
      toolUsage,
    };
  }

  /**
   * Execute a tool
   */
  async execute(name: string, args: Record<string, any>): Promise<RuntimeValue> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found`);
    }

    const startTime = Date.now();

    // Log execution start
    if (this.loggingEnabled) {
      const argsStr = JSON.stringify(args);
      process.stderr.write(`${BOLD}${MAGENTA}[TOOL]${RESET} ${YELLOW}⚙ ${name}${RESET} ${DIM}${argsStr}${RESET}\n`);
    }

    try {
      const result = await tool.handler(args);
      const duration = Date.now() - startTime;

      // Create log entry
      const logEntry: ToolExecutionLog = {
        name,
        arguments: args,
        result,
        timestamp: Date.now(),
        duration,
      };

      this.executionLog.push(logEntry);

      // Log execution success
      if (this.loggingEnabled) {
        const resultStr = typeof result === 'object' ? JSON.stringify(result) : String(result);
        process.stderr.write(`${BOLD}${MAGENTA}[TOOL]${RESET} ${GREEN}✓ ${name}${RESET} ${DIM}(${duration}ms)${RESET} → ${resultStr}\n`);
      }

      // Notify listeners
      for (const listener of this.listeners) {
        try {
          listener(logEntry);
        } catch (error) {
          console.error(`[Tool] Listener error:`, error);
        }
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Create error log entry
      const logEntry: ToolExecutionLog = {
        name,
        arguments: args,
        result: null,
        error: error as Error,
        timestamp: Date.now(),
        duration,
      };

      this.executionLog.push(logEntry);

      // Log execution failure
      if (this.loggingEnabled) {
        process.stderr.write(`${BOLD}${MAGENTA}[TOOL]${RESET} ${RED}✗ ${name} failed in ${duration}ms${RESET} ${error}\n`);
      }

      // Notify listeners
      for (const listener of this.listeners) {
        try {
          listener(logEntry);
        } catch (listenerError) {
          console.error(`[Tool] Listener error:`, listenerError);
        }
      }

      throw new Error(`Tool execution failed: ${error}`);
    }
  }

  /**
   * Convert tools to OpenRouter format
   */
  toOpenRouterFormat(): any[] {
    return this.getAll().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}
