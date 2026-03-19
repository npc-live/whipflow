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

/**
 * Convenience function to execute a program
 */
import { ProgramNode } from '../parser';
import { RuntimeEnvironment } from './environment';
import { Interpreter } from './interpreter';
import { ExecutionResult, RuntimeConfig } from './types';
import { ToolDefinition, ToolRegistry } from './tools';

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
