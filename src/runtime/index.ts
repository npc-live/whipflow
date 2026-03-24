/**
 * Runtime module exports
 */

export * from './types';
export * from './context';
export * from './environment';
export * from './interpreter';
export * from './cli-provider';
export * from './provider-config';
export * from './tools';
export * from './custom-tools-loader';
export * from './state-store';

/**
 * Convenience function to execute a program
 */
import { ProgramNode } from '../parser';
import { RuntimeEnvironment } from './environment';
import { Interpreter } from './interpreter';
import { ExecutionResult, RuntimeConfig } from './types';
import { ToolDefinition, ToolRegistry } from './tools';
import { StateStore, SessionRecord } from './state-store';

export async function execute(
  program: ProgramNode,
  config?: Partial<RuntimeConfig>,
  customTools?: ToolDefinition[]
): Promise<ExecutionResult> {
  const env = new RuntimeEnvironment(config);

  // Always create tool registry (needed for imports)
  const toolRegistry = new ToolRegistry();

  // Register custom tools if provided
  if (customTools && customTools.length > 0) {
    for (const tool of customTools) {
      toolRegistry.register(tool);
      env.log('info', `Registered custom tool: ${tool.name}`);
    }
  }

  const interpreter = new Interpreter(env, toolRegistry);
  return await interpreter.execute(program);
}

export async function executeWithState(
  program: ProgramNode,
  stateStore: StateStore,
  filePath: string,
  replaySessions: SessionRecord[],
  config?: Partial<RuntimeConfig>,
  customTools?: ToolDefinition[],
  onRunStarted?: (newRunId: number) => void,
  resumeUserInputs?: Record<string, string>,
): Promise<ExecutionResult> {
  const env = new RuntimeEnvironment(config);
  const toolRegistry = new ToolRegistry();
  if (customTools) {
    for (const tool of customTools) {
      toolRegistry.register(tool);
    }
  }
  // Restore variables: session snapshot first, then user inputs on top
  // (user_inputs are saved immediately on ask, so they survive even if no session completed)
  let resumeVariables: Record<string, unknown> = {};
  if (replaySessions.length > 0) {
    const last = replaySessions[replaySessions.length - 1];
    try { Object.assign(resumeVariables, JSON.parse(last.variablesJson)); } catch { /* ignore */ }
  }
  if (resumeUserInputs) {
    Object.assign(resumeVariables, resumeUserInputs);
  }

  const interpreter = new Interpreter(env, toolRegistry, stateStore, replaySessions,
    Object.keys(resumeVariables).length > 0 ? resumeVariables : undefined, onRunStarted);
  interpreter.setCurrentFileName(filePath);
  return await interpreter.execute(program);
}
