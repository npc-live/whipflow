/**
 * Runtime Type Definitions
 */

import { SourceSpan } from '../parser/tokens';

/**
 * Runtime value types
 */
export type RuntimeValue =
  | string
  | number
  | boolean
  | RuntimeValue[]
  | { [key: string]: RuntimeValue }
  | SessionResult
  | null
  | undefined;

/**
 * Result from an AI session execution
 */
export interface SessionResult {
  output: string;
  metadata: {
    model: string;
    duration: number;
    tokensUsed?: number;
    toolCalls?: any[];
  };
}

/**
 * Type guard for SessionResult
 */
export function isSessionResult(value: unknown): value is SessionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'output' in value &&
    'metadata' in value
  );
}

/**
 * Variable stored in context
 */
export interface Variable {
  name: string;
  value: RuntimeValue;
  isConst: boolean;
  declaredAt: SourceSpan;
}

/**
 * Context snapshot for passing to sessions
 */
export interface ContextSnapshot {
  variables: Record<string, RuntimeValue>;
  metadata: {
    timestamp: number;
    executionPath: string[];
  };
}

/**
 * Execution result
 */
export interface ExecutionResult {
  success: boolean;
  outputs: Map<string, RuntimeValue>;
  sessionOutputs: SessionResult[];  // All session outputs, including standalone
  finalContext: ContextSnapshot;
  errors: ExecutionError[];
  metadata: {
    duration: number;
    sessionsCreated: number;
    statementsExecuted: number;
  };
}

/**
 * Execution error
 */
export interface ExecutionError {
  type: 'syntax' | 'runtime' | 'timeout' | 'permission' | 'variable';
  message: string;
  location?: SourceSpan;
  stack: string[];
}

/**
 * Runtime configuration
 */
export interface RuntimeConfig {
  // Default model for sessions
  defaultModel: 'opus' | 'sonnet' | 'haiku';

  // Timeout settings (in milliseconds)
  sessionTimeout: number;
  totalExecutionTimeout: number;

  // Safety limits
  maxLoopIterations: number;
  maxCallDepth: number;
  maxConcurrentSessions: number;

  // Memory limits (in bytes)
  maxVariableSize: number;
  maxTotalMemory: number;

  // Debug options
  debug: boolean;
  traceExecution: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  /**
   * Default provider for all sessions when no provider is specified on the
   * agent definition. Defaults to 'claude-code'.
   */
  defaultProvider?: string;

  /**
   * Provider used for condition evaluation (discretion blocks) and choice
   * selection. Falls back to defaultProvider when unset.
   */
  conditionProvider?: string;
}

/**
 * Default runtime configuration
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  defaultModel: 'sonnet',
  sessionTimeout: 300000, // 5 minutes
  totalExecutionTimeout: 3600000, // 1 hour
  maxLoopIterations: 100,
  maxCallDepth: 50,
  maxConcurrentSessions: 10,
  maxVariableSize: 10 * 1024 * 1024, // 10 MB
  maxTotalMemory: 100 * 1024 * 1024, // 100 MB
  debug: false,
  traceExecution: false,
  logLevel: 'info',
};

/**
 * Statement execution result
 */
export interface StatementResult {
  value?: RuntimeValue;
  controlFlow?: ControlFlow;
}

/**
 * Control flow directives
 */
/** Built-in provider names */
export const BUILTIN_PROVIDERS = ['claude-code', 'claude', 'opencode', 'aider', 'pi', 'fetch', 'whipflow-acp'] as const;

export type ControlFlow =
  | { type: 'break' }
  | { type: 'continue' }
  | { type: 'return'; value?: RuntimeValue }
  | { type: 'throw'; error: Error };

/**
 * Agent instance configuration
 */
export interface AgentInstance {
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  provider?: string;  // AI provider: 'claude-code', 'claude', 'opencode', 'custom:bin [args]'
  skills: string[];    // 引导性技能：补充提示词的规范/知识
  tools: string[];     // 可执行工具：function 输入输出明确
  permissions: PermissionRules;
  defaultPrompt?: string;
  prompt?: string;  // Agent-specific system prompt
}

/**
 * Permission rules for an agent
 */
export interface PermissionRules {
  bash?: 'allow' | 'deny';
  file_read?: 'allow' | 'deny';
  file_write?: 'allow' | 'deny';
  network?: 'allow' | 'deny';
  tools?: string[];  // List of allowed tool names
  [key: string]: 'allow' | 'deny' | string[] | undefined;
}

/**
 * Session specification for execution
 */
export interface SessionSpec {
  agent: AgentInstance | null; // null = use default
  prompt: string;
  context: ContextSnapshot | null;
  name?: string; // for named results in parallel blocks
  properties?: Record<string, RuntimeValue>;
}

/**
 * Parallel execution strategy
 */
export type JoinStrategy = 'all' | 'first' | 'any';

/**
 * Failure handling strategy for parallel blocks
 */
export type FailureStrategy = 'fail-fast' | 'continue' | 'ignore';

/**
 * Parallel execution result
 */
export interface ParallelResult {
  results: Map<string, SessionResult>;
  errors: Map<string, Error>;
  completedCount: number;
  failedCount: number;
}

/**
 * Execution event for tracking history
 */
export interface ExecutionEvent {
  type: 'statement' | 'session' | 'condition' | 'error';
  description: string;
  timestamp: number;
  result?: any;
}

/**
 * Rich execution context for discretion evaluation
 * Provides comprehensive context to LLM for better decision making
 */
export interface EnrichedExecutionContext {
  // Current execution state
  fileName: string | null;
  currentBlock: string | null;
  currentIteration: number | null;

  // Variable state
  variables: Record<string, RuntimeValue>;
  recentChanges: string[];  // Recent variable assignments

  // Execution history
  recentEvents: ExecutionEvent[];  // Last 5-10 events
  executionPath: string[];  // Stack of block/function names

  // Progress tracking
  totalStatements: number;
  executedStatements: number;
  remainingStatements: number;

  // Session results
  recentSessionOutputs: string[];  // Last few session outputs

  // Loop context (if in a loop)
  loopInfo: {
    iteration: number;
    maxIterations: number | null;
    previousResults: any[];
  } | null;
}
