/**
 * Interpreter - executes whipflow programs
 */

import {
  ProgramNode,
  StatementNode,
  SessionStatementNode,
  LetBindingNode,
  ConstBindingNode,
  AssignmentNode,
  ExpressionNode,
  StringLiteralNode,
  NumberLiteralNode,
  IdentifierNode,
  AgentDefinitionNode,
  PropertyNode,
  ArrayExpressionNode,
  ObjectExpressionNode,
  InterpolatedStringNode,
  ImportStatementNode,
  RepeatBlockNode,
  ForEachBlockNode,
  IfStatementNode,
  ElseIfClauseNode,
  DiscretionNode,
  LoopBlockNode,
  TryBlockNode,
  ThrowStatementNode,
  ReturnStatementNode,
  ParallelBlockNode,
  BlockDefinitionNode,
  DoBlockNode,
  PipeExpressionNode,
  PipeOperationNode,
  ArrowExpressionNode,
  ChoiceBlockNode,
  ChoiceOptionNode,
  AskStatementNode,
  RunStatementNode,
  SkillInvocationNode,
  SkillParamNode,
} from '../parser';
import { parse } from '../parser';
import { RuntimeEnvironment } from './environment';
import * as fs from 'fs';
import * as path from 'path';
import {
  ExecutionResult,
  ExecutionError,
  RuntimeValue,
  StatementResult,
  SessionResult,
  SessionSpec,
  AgentInstance,
  ContextSnapshot,
  ExecutionEvent,
  EnrichedExecutionContext,
  isSessionResult,
} from './types';
import { CliProvider, createCliProvider } from './cli-provider';
import { ToolDefinition, ToolRegistry } from './tools';
import { loadCustomTools } from './custom-tools-loader';
import { getToolsConfig } from './provider-config';
import { RESET, BOLD, CYAN, GREEN } from './ansi';
import { StateStore, SessionRecord } from './state-store';

/**
 * Special exception used to signal a return statement
 * This is not an error, but a control flow mechanism
 */
class ReturnSignal extends Error {
  constructor(public readonly value: RuntimeValue) {
    super('ReturnSignal');
    this.name = 'ReturnSignal';
  }
}

/**
 * Interpreter class
 */
export class Interpreter {
  private env: RuntimeEnvironment;
  private toolRegistry: ToolRegistry | null;
  private blocks: Map<string, BlockDefinitionNode> = new Map();

  // Cache of CLI providers keyed by provider string
  private cliProviderCache: Map<string, CliProvider> = new Map();

  // Buffered stdin lines for ask statements (handles piped/non-TTY input correctly)
  private stdinLineBuffer: string[] = [];
  private stdinRemainder: string = '';
  private stdinEnded: boolean = false;

  // State persistence
  private stateStore: StateStore | null = null;
  private currentRunId: number | null = null;
  private currentSessionIndex: number = 0;
  private replaySessions: SessionRecord[] = [];
  private onRunStarted: ((newRunId: number) => void) | null = null;

  // Context enrichment tracking
  private executionEvents: ExecutionEvent[] = [];
  private currentFileName: string | null = null;
  private currentBlockStack: string[] = [];
  private totalStatements: number = 0;
  private executedStatements: number = 0;
  private recentSessionOutputs: string[] = [];
  private allSessionOutputs: SessionResult[] = [];  // Track all session outputs
  private loopContext: {
    iteration: number;
    maxIterations: number | null;
    previousResults: any[];
  } | null = null;

  constructor(
    env: RuntimeEnvironment,
    toolRegistry?: ToolRegistry | null,
    stateStore?: StateStore | null,
    replaySessions?: SessionRecord[],
    resumeVariables?: Record<string, unknown>,
    onRunStarted?: (newRunId: number) => void,
  ) {
    this.env = env;
    this.toolRegistry = toolRegistry || null;
    this.stateStore = stateStore || null;
    this.replaySessions = replaySessions || [];
    this.onRunStarted = onRunStarted || null;
    if (resumeVariables) {
      for (const [name, value] of Object.entries(resumeVariables)) {
        this.env.contextManager.declareVariable(name, value as any, false, { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } });
      }
    }
  }

  setCurrentFileName(fileName: string): void {
    this.currentFileName = fileName;
  }

  /** Get or create a CliProvider for the given provider string */
  private getCliProvider(provider: string): CliProvider | null {
    if (!this.cliProviderCache.has(provider)) {
      const p = createCliProvider(provider);
      if (p) this.cliProviderCache.set(provider, p);
      else return null;
    }
    return this.cliProviderCache.get(provider)!;
  }

  /**
   * Execute a program
   */
  async execute(program: ProgramNode): Promise<ExecutionResult> {
    this.env.startExecution();
    this.env.log('info', 'Starting program execution');

    // Initialize context tracking
    this.totalStatements = program.statements.length;
    this.executedStatements = 0;
    this.executionEvents = [];
    this.recentSessionOutputs = [];
    this.allSessionOutputs = [];
    this.currentBlockStack = [];
    this.currentSessionIndex = 0;

    if (this.stateStore && this.currentFileName) {
      this.currentRunId = this.stateStore.startRun(this.currentFileName);

      // Batch-persist ALL replay sessions into the new run upfront, before executing
      // anything. This ensures that if execution crashes immediately, the next resume
      // can still recover the full set of previously completed sessions.
      if (this.replaySessions.length > 0 && this.currentRunId !== null) {
        for (const record of this.replaySessions) {
          const replayed: SessionResult = {
            output: record.output,
            metadata: {
              model: record.model,
              duration: record.durationMs,
              tokensUsed: record.tokensUsed ?? undefined,
              toolCalls: record.toolCallsJson ? JSON.parse(record.toolCallsJson) : undefined,
            },
          };
          let vars: Record<string, unknown> = {};
          try { vars = JSON.parse(record.variablesJson); } catch { /* ignore */ }
          this.stateStore.recordSession(this.currentRunId, record.sessionIndex, record.prompt, replayed, vars);
        }
      }

      // Now it's safe to delete the old run — new run has all sessions atomically
      if (this.onRunStarted && this.currentRunId !== null) {
        this.onRunStarted(this.currentRunId);
      }
    }

    try {
      // Execute all statements sequentially
      for (const statement of program.statements) {
        await this.executeStatement(statement);
        this.executedStatements++;

        // Check for timeout
        if (this.env.hasTimedOut()) {
          throw new Error('Execution timed out');
        }
      }

      // Collect final results
      const outputs = this.env.contextManager.getAllVariables();
      const finalContext = this.env.contextManager.captureContext();

      this.env.log('info', `Execution completed successfully in ${this.env.getExecutionDuration()}ms`);

      if (this.stateStore && this.currentRunId !== null) {
        this.stateStore.completeRun(this.currentRunId);
      }

      return {
        success: true,
        outputs,
        sessionOutputs: this.allSessionOutputs,
        finalContext,
        errors: this.env.getErrors(),
        metadata: {
          duration: this.env.getExecutionDuration(),
          sessionsCreated: this.env.getSessionCount(),
          statementsExecuted: this.env.getStatementCount(),
        },
      };
    } catch (error) {
      this.env.log('error', `Execution failed: ${error}`);

      const executionError: ExecutionError = {
        type: 'runtime',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split('\n') || [] : [],
      };

      this.env.addError(executionError);

      if (this.stateStore && this.currentRunId !== null) {
        this.stateStore.failRun(this.currentRunId, executionError.message);
      }

      return {
        success: false,
        outputs: this.env.contextManager.getAllVariables(),
        sessionOutputs: this.allSessionOutputs,
        finalContext: this.env.contextManager.captureContext(),
        errors: this.env.getErrors(),
        metadata: {
          duration: this.env.getExecutionDuration(),
          sessionsCreated: this.env.getSessionCount(),
          statementsExecuted: this.env.getStatementCount(),
        },
      };
    }
  }

  /**
   * Execute a statement
   */
  private async executeStatement(statement: StatementNode): Promise<StatementResult> {
    this.env.incrementStatementCount();
    this.env.trace(`Executing statement: ${statement.type}`);

    switch (statement.type) {
      case 'SessionStatement':
        return await this.executeSessionStatement(statement as SessionStatementNode);

      case 'LetBinding':
        return await this.executeLetBinding(statement as LetBindingNode);

      case 'ConstBinding':
        return await this.executeConstBinding(statement as ConstBindingNode);

      case 'Assignment':
        return await this.executeAssignment(statement as AssignmentNode);

      case 'AgentDefinition':
        return await this.executeAgentDefinition(statement as AgentDefinitionNode);

      case 'ImportStatement':
        return await this.executeImportStatement(statement as ImportStatementNode);

      case 'RunStatement':
        return await this.executeRunStatement(statement as RunStatementNode);

      case 'CommentStatement':
        // Comments are ignored during execution
        return {};

      case 'RepeatBlock':
        return await this.executeRepeatBlock(statement as RepeatBlockNode);

      case 'ForEachBlock':
        return await this.executeForEachBlock(statement as ForEachBlockNode);

      case 'IfStatement':
        return await this.executeIfStatement(statement as IfStatementNode);

      case 'LoopBlock':
        return await this.executeLoopBlock(statement as LoopBlockNode);

      case 'TryBlock':
        return await this.executeTryBlock(statement as TryBlockNode);

      case 'AskStatement':
        return await this.executeAskStatement(statement as AskStatementNode);

      case 'SkillInvocation':
        return await this.executeSkillInvocation(statement as SkillInvocationNode);

      case 'ThrowStatement':
        return await this.executeThrowStatement(statement as ThrowStatementNode);

      case 'ReturnStatement':
        return await this.executeReturnStatement(statement as ReturnStatementNode);

      case 'ParallelBlock':
        return await this.executeParallelBlock(statement as ParallelBlockNode);

      case 'BlockDefinition':
        return await this.executeBlockDefinition(statement as BlockDefinitionNode);

      case 'DoBlock':
        return await this.executeDoBlock(statement as DoBlockNode);

      case 'ChoiceBlock':
        return await this.executeChoiceBlock(statement as ChoiceBlockNode);

      default:
        throw new Error(`Unsupported statement type: ${statement.type}`);
    }
  }

  /**
   * Execute a session statement
   */
  private async executeSessionStatement(statement: SessionStatementNode): Promise<StatementResult> {
    this.env.log('info', 'Executing session statement');

    // RESUME: check if this session index has already been completed
    const replayRecord = this.replaySessions.find(r => r.sessionIndex === this.currentSessionIndex);
    if (replayRecord) {
      this.env.log('info', `[REPLAYED] session ${this.currentSessionIndex} from state`);
      const replayed: SessionResult = {
        output: replayRecord.output,
        metadata: {
          model: replayRecord.model,
          duration: replayRecord.durationMs,
          tokensUsed: replayRecord.tokensUsed ?? undefined,
          toolCalls: replayRecord.toolCallsJson ? JSON.parse(replayRecord.toolCallsJson) : undefined,
        },
      };
      this.trackSessionOutput(replayed);
      this.currentSessionIndex++;
      return { value: replayed };
    }

    // Build session spec
    const spec = await this.buildSessionSpec(statement);

    // Check for retry property
    const retryProp = statement.properties.find(p => p.name.name === 'retry');
    const backoffProp = statement.properties.find(p => p.name.name === 'backoff');

    let retries = 1; // Default: no retry
    let backoffStrategy: 'none' | 'linear' | 'exponential' = 'none';

    if (retryProp) {
      const retryValue = await this.evaluateExpression(retryProp.value);
      if (typeof retryValue === 'number' && retryValue > 0) {
        retries = Math.floor(retryValue);
      }
    }

    if (backoffProp) {
      const backoffValue = await this.evaluateExpression(backoffProp.value);
      if (typeof backoffValue === 'string') {
        if (backoffValue === 'linear' || backoffValue === 'exponential') {
          backoffStrategy = backoffValue;
        }
      }
    }

    // Execute the session with retry logic
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this.executeSession(spec);
        if (attempt > 1) {
          this.env.log('info', `Session succeeded on attempt ${attempt}`);
        }

        // Track session output for context enrichment and final display
        this.trackSessionOutput(result);

        // Persist session to state store
        if (this.stateStore && this.currentRunId !== null) {
          const vars = Object.fromEntries(this.env.contextManager.getAllVariables());
          this.stateStore.recordSession(this.currentRunId, this.currentSessionIndex, spec.prompt, result, vars);
        }
        this.currentSessionIndex++;

        // Add to execution events
        this.addExecutionEvent('session', `Session completed: ${result.output.substring(0, 50)}...`, result);

        return { value: result };
      } catch (error) {
        lastError = error as Error;
        this.env.log('warn', `Session failed on attempt ${attempt}/${retries}: ${lastError.message}`);

        // If this wasn't the last attempt, apply backoff
        if (attempt < retries) {
          const delay = this.calculateBackoffDelay(attempt, backoffStrategy);
          if (delay > 0) {
            this.env.log('info', `Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
    }

    // All retries exhausted, throw the last error
    throw lastError;
  }

  /**
   * Calculate backoff delay in milliseconds
   */
  private calculateBackoffDelay(attempt: number, strategy: 'none' | 'linear' | 'exponential'): number {
    const baseDelay = 1000; // 1 second base delay

    switch (strategy) {
      case 'linear':
        return baseDelay * attempt;
      case 'exponential':
        return baseDelay * Math.pow(2, attempt - 1);
      case 'none':
      default:
        return 0;
    }
  }

  /**
   * Execute a let binding
   */
  private async executeLetBinding(binding: LetBindingNode): Promise<StatementResult> {
    this.env.trace(`Declaring variable: ${binding.name.name}`);

    // Evaluate the value expression
    const value = await this.evaluateExpression(binding.value);

    // Declare the variable (or overwrite if already injected by resume state)
    if (this.env.contextManager.hasVariable(binding.name.name)) {
      this.env.contextManager.setVariable(binding.name.name, value);
    } else {
      this.env.contextManager.declareVariable(binding.name.name, value, false, binding.span);
    }

    this.env.log('debug', `Variable '${binding.name.name}' declared with value: ${JSON.stringify(value)}`);

    return {};
  }

  /**
   * Execute a const binding
   */
  private async executeConstBinding(binding: ConstBindingNode): Promise<StatementResult> {
    this.env.trace(`Declaring const: ${binding.name.name}`);

    // Evaluate the value expression
    const value = await this.evaluateExpression(binding.value);

    // Declare the constant (or overwrite if already injected by resume state)
    if (this.env.contextManager.hasVariable(binding.name.name)) {
      this.env.contextManager.setVariable(binding.name.name, value);
    } else {
      this.env.contextManager.declareVariable(binding.name.name, value, true, binding.span);
    }

    this.env.log('debug', `Const '${binding.name.name}' declared with value: ${JSON.stringify(value)}`);

    return {};
  }

  /**
   * Execute an assignment
   */
  private async executeAssignment(assignment: AssignmentNode): Promise<StatementResult> {
    this.env.trace(`Assigning to variable: ${assignment.name.name}`);

    // Evaluate the value expression
    const value = await this.evaluateExpression(assignment.value);

    // Auto-declare the variable if not yet declared (implicit let)
    if (!this.env.contextManager.hasVariable(assignment.name.name)) {
      this.env.contextManager.declareVariable(assignment.name.name, value, false, assignment.name.span);
    } else {
      this.env.contextManager.setVariable(assignment.name.name, value);
    }

    this.env.log('debug', `Variable '${assignment.name.name}' assigned value: ${JSON.stringify(value)}`);

    return {};
  }

  /**
   * Execute an import statement
   */
  private async executeImportStatement(stmt: ImportStatementNode): Promise<StatementResult> {
    const skillName = stmt.skillName.value;
    const source = stmt.source.value;

    this.env.log('info', `Importing skill '${skillName}' from ${source}`);

    if (!this.toolRegistry) {
      this.env.log('warn', `Cannot import skill '${skillName}': no tool registry available`);
      return {};
    }

    try {
      let tool: ToolDefinition;

      if (source.startsWith('github:')) {
        tool = await this.loadToolFromGitHub(source, skillName);
      } else if (source.startsWith('npm:')) {
        tool = await this.loadToolFromNPM(source, skillName);
      } else if (source.startsWith('http://') || source.startsWith('https://')) {
        tool = await this.loadToolFromURL(source, skillName);
      } else {
        tool = await this.loadToolFromFile(source, skillName);
      }

      this.toolRegistry.register(tool);
      this.env.log('info', `Successfully imported skill '${skillName}'`);

      return {};
    } catch (error) {
      this.env.log('error', `Failed to import skill '${skillName}': ${error}`);
      throw new Error(`Import failed: ${error}`);
    }
  }

  /**
   * Execute a run statement: run "path/to/other.whip"
   * Resolves the path relative to the current file, parses and executes it
   * in the current variable scope so its outputs are accessible afterwards.
   */
  private async executeRunStatement(stmt: RunStatementNode): Promise<StatementResult> {
    const rawPath = stmt.filePath.value;

    // Resolve relative to the current working directory
    const resolved = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(process.cwd(), rawPath);

    this.env.log('info', `Running sub-workflow: ${resolved}`);

    let source: string;
    try {
      source = fs.readFileSync(resolved, 'utf-8');
    } catch (err) {
      throw new Error(`run: cannot read file "${resolved}": ${err}`);
    }

    const parseResult = parse(source);
    if (parseResult.errors.length > 0) {
      const msg = parseResult.errors.map(e => e.message).join('; ');
      throw new Error(`run: parse errors in "${resolved}": ${msg}`);
    }

    // Execute every statement in the sub-file within its own scope
    const sessionsBefore = this.allSessionOutputs.length;

    this.env.contextManager.pushScope();
    try {
      for (const statement of parseResult.program.statements) {
        await this.executeStatement(statement);
      }
    } finally {
      this.env.contextManager.popScope();
    }

    this.env.log('info', `Completed sub-workflow: ${resolved}`);

    const newSessions = this.allSessionOutputs.slice(sessionsBefore);
    if (newSessions.length > 0) {
      const last = newSessions[newSessions.length - 1];
      return { value: last.output };
    }
    return {};
  }

  /**
   * Load tool from GitHub repository
   */
  private async loadToolFromGitHub(source: string, skillName: string): Promise<ToolDefinition> {
    // Parse: github:owner/repo -> https://raw.githubusercontent.com/owner/repo/main/...
    const match = source.match(/^github:(.+)$/);
    if (!match) {
      throw new Error(`Invalid GitHub source format: ${source}`);
    }

    const repo = match[1];

    // Special handling for anthropics/skills repository (Markdown-based skills)
    if (repo === 'anthropics/skills') {
      return await this.loadAnthropicSkill(skillName);
    }

    // Standard JSON-based tool definition
    const url = `https://raw.githubusercontent.com/${repo}/main/${skillName}.json`;

    this.env.log('debug', `Loading tool from GitHub: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch from GitHub: ${response.statusText}`);
    }

    const definition = await response.json();
    return this.parseToolDefinition(definition, skillName);
  }

  /**
   * Load skill from Anthropic Skills repository (Markdown format)
   */
  private async loadAnthropicSkill(skillName: string): Promise<ToolDefinition> {
    const url = `https://raw.githubusercontent.com/anthropics/skills/main/skills/${skillName}/SKILL.md`;

    this.env.log('debug', `Loading Anthropic skill from: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch Anthropic skill: ${response.statusText}`);
    }

    const markdown = await response.text();

    // Parse frontmatter (YAML between --- delimiters)
    const frontmatterMatch = markdown.match(/^---\n([\s\S]+?)\n---/);
    let name = skillName;
    let description = `Skill: ${skillName}`;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
    }

    // Return as a ToolDefinition with parameters
    return {
      name,
      description: `${description}\n\n${markdown}`,
      parameters: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        throw new Error('Skills are not executable - they provide guidance to the AI');
      },
    };
  }

  /**
   * Load tool from NPM package
   */
  private async loadToolFromNPM(source: string, skillName: string): Promise<ToolDefinition> {
    // Parse: npm:package-name
    const match = source.match(/^npm:(.+)$/);
    if (!match) {
      throw new Error(`Invalid NPM source format: ${source}`);
    }

    const packageName = match[1];

    this.env.log('debug', `Loading tool from NPM: ${packageName}`);

    // Try to dynamically import the package
    try {
      const module = await import(packageName);
      const tool = module[skillName] || module.default;

      if (!tool || typeof tool !== 'object') {
        throw new Error(`Tool '${skillName}' not found in package ${packageName}`);
      }

      return tool as ToolDefinition;
    } catch (error) {
      throw new Error(`Failed to load from NPM: ${error}`);
    }
  }

  /**
   * Load tool from URL
   */
  private async loadToolFromURL(url: string, skillName: string): Promise<ToolDefinition> {
    this.env.log('debug', `Loading tool from URL: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch from URL: ${response.statusText}`);
    }

    const definition = await response.json();
    return this.parseToolDefinition(definition, skillName);
  }

  /**
   * Load tool from local file
   */
  private async loadToolFromFile(filePath: string, skillName: string): Promise<ToolDefinition> {
    this.env.log('debug', `Loading tool from file: ${filePath}`);

    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      // Resolve relative to current working directory
      const resolvedPath = path.resolve(process.cwd(), filePath);
      const content = await fs.readFile(resolvedPath, 'utf-8');

      let definition;
      if (filePath.endsWith('.json')) {
        definition = JSON.parse(content);
      } else if (filePath.endsWith('.js') || filePath.endsWith('.ts')) {
        // For JS/TS files, try to import them
        const module = await import(resolvedPath);
        definition = module[skillName] || module.default;
      } else {
        throw new Error(`Unsupported file type: ${filePath}`);
      }

      return this.parseToolDefinition(definition, skillName);
    } catch (error) {
      throw new Error(`Failed to load from file: ${error}`);
    }
  }

  /**
   * Parse a tool definition from JSON
   */
  private parseToolDefinition(definition: any, skillName: string): ToolDefinition {
    if (!definition.name) {
      definition.name = skillName;
    }

    if (!definition.description || !definition.parameters || !definition.handler) {
      throw new Error(`Invalid tool definition: missing required fields (description, parameters, or handler)`);
    }

    // If handler is a string, it needs to be evaluated (with caution!)
    if (typeof definition.handler === 'string') {
      this.env.log('warn', `Tool '${skillName}' uses string handler - evaluating with caution`);
      // For safety, we wrap it in an async function
      definition.handler = new Function('return ' + definition.handler)();
    }

    return definition as ToolDefinition;
  }

  /**
   * Execute an agent definition
   */
  private async executeAgentDefinition(agent: AgentDefinitionNode): Promise<StatementResult> {
    this.env.trace(`Defining agent: ${agent.name.name}`);

    // Extract properties
    const properties = new Map<string, RuntimeValue>();
    for (const prop of agent.properties) {
      // For model property, if it's an identifier, use its name directly
      if (prop.name.name === 'model' && prop.value.type === 'Identifier') {
        properties.set('model', (prop.value as IdentifierNode).name);
      } else {
        const value = await this.evaluateExpression(prop.value);
        properties.set(prop.name.name, value);
      }
    }

    // Build agent instance
    const model = (properties.get('model') as string) || this.env.config.defaultModel;
    const provider = (properties.get('provider') as string) || this.env.config.defaultProvider || 'claude-code';

    const agentInstance: AgentInstance = {
      name: agent.name.name,
      model: (model === 'opus' || model === 'sonnet' || model === 'haiku') ? model : this.env.config.defaultModel,
      provider,
      skills: (properties.get('skills') as string[]) || [],
      tools: (properties.get('tools') as string[]) || [],
      permissions: (properties.get('permissions') as any) || {},
      defaultPrompt: properties.get('prompt') as string | undefined,
      prompt: properties.get('prompt') as string | undefined,
    };

    // Register the agent
    this.env.registerAgent(agentInstance);

    this.env.log('info', `Agent '${agent.name.name}' registered with model ${agentInstance.model}`);

    return {};
  }

  /**
   * Evaluate an expression
   */
  private async evaluateExpression(expr: ExpressionNode): Promise<RuntimeValue> {
    switch (expr.type) {
      case 'StringLiteral':
        return (expr as StringLiteralNode).value;

      case 'InterpolatedString':
        return await this.evaluateInterpolatedString(expr as InterpolatedStringNode);

      case 'NumberLiteral':
        return (expr as NumberLiteralNode).value;

      case 'Identifier':
        return this.env.contextManager.getVariable((expr as IdentifierNode).name);

      case 'ArrayExpression':
        return await this.evaluateArrayExpression(expr as ArrayExpressionNode);

      case 'ObjectExpression':
        return await this.evaluateObjectExpression(expr as ObjectExpressionNode);

      case 'SessionStatement':
        const result = await this.executeSessionStatement(expr as SessionStatementNode);
        return result.value || null;

      case 'DoBlock':
        const doResult = await this.executeDoBlock(expr as DoBlockNode);
        return doResult.value !== undefined ? doResult.value : null;

      case 'PipeExpression':
        return await this.evaluatePipeExpression(expr as PipeExpressionNode);

      case 'ArrowExpression':
        return await this.evaluateArrowExpression(expr as ArrowExpressionNode);

      case 'SkillInvocation': {
        const skillResult = await this.executeSkillInvocation(expr as SkillInvocationNode);
        return skillResult.value !== undefined ? skillResult.value : null;
      }

      case 'RunStatement': {
        const runResult = await this.executeRunStatement(expr as RunStatementNode);
        return runResult.value !== undefined ? runResult.value : null;
      }

      default:
        throw new Error(`Unsupported expression type: ${expr.type}`);
    }
  }

  /**
   * Evaluate an interpolated string
   */
  private async evaluateInterpolatedString(str: InterpolatedStringNode): Promise<string> {
    let result = '';

    for (const part of str.parts) {
      if (part.type === 'StringLiteral') {
        result += (part as StringLiteralNode).value;
      } else if (part.type === 'Identifier') {
        const varName = (part as IdentifierNode).name;

        // If the variable is not defined, treat {varname} as a literal string
        // (common in AI-generated prompts that contain URL path templates like /markets/{id})
        if (!this.env.contextManager.hasVariable(varName)) {
          result += `{${varName}}`;
          continue;
        }

        const value = this.env.contextManager.getVariable(varName);

        // Handle SessionResult objects - extract the output field
        if (isSessionResult(value)) {
          result += String(value.output);
        } else if (value === null || value === undefined) {
          result += 'null';
        } else if (typeof value === 'object') {
          // For other objects, stringify them nicely
          result += JSON.stringify(value);
        } else {
          result += String(value);
        }
      }
    }

    return result;
  }

  /**
   * Evaluate an array expression
   */
  private async evaluateArrayExpression(arr: ArrayExpressionNode): Promise<RuntimeValue[]> {
    const elements: RuntimeValue[] = [];

    for (const elem of arr.elements) {
      const value = await this.evaluateExpression(elem);
      elements.push(value);
    }

    return elements;
  }

  /**
   * Evaluate an object expression
   */
  private async evaluateObjectExpression(obj: ObjectExpressionNode): Promise<Record<string, RuntimeValue>> {
    const result: Record<string, RuntimeValue> = {};

    for (const prop of obj.properties) {
      const value = await this.evaluateExpression(prop.value);
      result[prop.name.name] = value;
    }

    return result;
  }

  /**
   * Build a session spec from a session statement
   */
  private async buildSessionSpec(statement: SessionStatementNode): Promise<SessionSpec> {
    // Get agent if specified
    let agent: AgentInstance | null = null;
    if (statement.agent) {
      agent = this.env.getAgent(statement.agent.name) || null;
    }

    // Get prompt
    let prompt = '';
    if (statement.prompt) {
      if (statement.prompt.type === 'InterpolatedString') {
        prompt = await this.evaluateInterpolatedString(statement.prompt);
      } else if (statement.prompt.type === 'StringLiteral') {
        prompt = statement.prompt.value;
      }
    }

    // If no prompt provided but we have an agent with default prompt, use that
    if (!prompt && agent?.defaultPrompt) {
      prompt = agent.defaultPrompt;
    }

    // Get prompt from properties if specified
    const promptProp = statement.properties.find(p => p.name.name === 'prompt');
    if (promptProp) {
      const promptValue = await this.evaluateExpression(promptProp.value);
      if (typeof promptValue === 'string') {
        prompt = promptValue;
      }
    }

    // Get context
    let context: ContextSnapshot | null = null;
    const contextProp = statement.properties.find(p => p.name.name === 'context');
    if (contextProp) {
      // Explicit context specified by user
      context = await this.buildContext(contextProp.value);
    } else if (this.allSessionOutputs.length > 0) {
      // Implicit context: automatically include recent session history
      // This allows sessions to see previous session outputs without explicit wiring
      const maxHistoryItems = 5; // Keep last 5 sessions to avoid token explosion
      const recentSessions = this.allSessionOutputs.slice(-maxHistoryItems);

      // Build context with conversation history
      const variables: Record<string, RuntimeValue> = {};

      // Add each previous session as a numbered conversation turn
      recentSessions.forEach((session, index) => {
        const turnNumber = this.allSessionOutputs.length - recentSessions.length + index + 1;
        variables[`conversation_turn_${turnNumber}`] = session.output;
      });

      // Also include current variables for reference
      const currentVars = this.env.contextManager.getAllVariables();
      for (const [key, value] of currentVars.entries()) {
        if (!key.startsWith('conversation_turn_')) {
          variables[key] = value;
        }
      }

      context = {
        variables,
        metadata: {
          timestamp: Date.now(),
          executionPath: this.currentBlockStack,
        },
      };
    }

    // Get other properties
    const properties: Record<string, RuntimeValue> = {};
    for (const prop of statement.properties) {
      if (prop.name.name !== 'context' && prop.name.name !== 'prompt') {
        properties[prop.name.name] = await this.evaluateExpression(prop.value);
      }
    }

    return {
      agent,
      prompt,
      context,
      name: statement.name?.name,
      properties,
    };
  }

  /**
   * Build context from an expression
   */
  private async buildContext(expr: ExpressionNode): Promise<ContextSnapshot> {
    if (expr.type === 'Identifier') {
      // context: varName
      const name = (expr as IdentifierNode).name;
      return this.env.contextManager.captureContext([name]);
    } else if (expr.type === 'ArrayExpression') {
      // context: [var1, var2, var3]
      const names = (expr as ArrayExpressionNode).elements
        .filter(e => e.type === 'Identifier')
        .map(e => (e as IdentifierNode).name);
      return this.env.contextManager.captureContext(names);
    } else if (expr.type === 'ObjectExpression') {
      // context: { var1, var2 }
      const names = (expr as ObjectExpressionNode).properties.map(p => p.name.name);
      return this.env.contextManager.captureContext(names);
    }

    // Default: capture all context
    return this.env.contextManager.captureContext();
  }

  /**
   * Execute a session using OpenRouter or mock
   */
  private async executeSession(spec: SessionSpec): Promise<SessionResult> {
    this.env.incrementSessionCount();
    this.env.log('info', `Executing session: ${spec.prompt}`);

    // Handle skills (prompt guidance) and tools (executable functions) separately
    let allowedTools: string[] | undefined = undefined;
    let skillPrompts: string[] = [];

    // Default tools that are always available (unless explicitly restricted)
    const DEFAULT_TOOLS = ['read', 'write', 'edit', 'bash'];

    // Determine which tools to enable
    if (spec.agent && spec.agent.tools && spec.agent.tools.length > 0) {
      // Agent explicitly specifies tools - use those
      allowedTools = spec.agent.tools;

      // Apply permission restrictions if defined
      if (spec.agent.permissions && spec.agent.permissions.tools) {
        const permittedTools = spec.agent.permissions.tools;
        if (Array.isArray(permittedTools)) {
          allowedTools = allowedTools.filter(tool => permittedTools.includes(tool));
          this.env.log('info', `Agent permissions restrict tools to: [${allowedTools.join(', ')}]`);
        }
      }

      this.env.log('info', `Agent has ${allowedTools.length} tool(s) enabled: [${allowedTools.join(', ')}]`);
    } else {
      // No agent or no tools specified - use default tools
      allowedTools = DEFAULT_TOOLS;
      this.env.log('info', `Using default tools: [${allowedTools.join(', ')}]`);
    }

    const enableTools = allowedTools.length > 0;

    // Get skills (prompt guidance/knowledge)
    if (spec.agent && spec.agent.skills && spec.agent.skills.length > 0) {
      this.env.log('info', `Agent has ${spec.agent.skills.length} skill(s) for prompt guidance: [${spec.agent.skills.join(', ')}]`);

      // Load skill content from tool registry
      if (this.toolRegistry) {
        for (const skillName of spec.agent.skills) {
          const skillDef = this.toolRegistry.get(skillName);
          // For now, skills are treated as regular tools
          // In the future, we might want to distinguish between executable tools and guidance skills
          if (skillDef) {
            // If the tool has a description, use it as guidance
            skillPrompts.push(`Skill: ${skillName}\n${skillDef.description}`);
            this.env.log('info', `Loaded skill guidance for: ${skillName}`);
          } else {
            this.env.log('warn', `Skill not found: ${skillName}`);
          }
        }
      }
    }

    // Load custom tools from ~/.prose/tools/ (or configured toolsDir)
    const toolsCfg = getToolsConfig();
    const customTools = loadCustomTools(toolsCfg.toolsDir, toolsCfg.tools);
    if (customTools.toolNames.length > 0) {
      // bash is needed to run custom tool commands — ensure it's in allowedTools
      if (allowedTools && !allowedTools.includes('bash')) {
        allowedTools = [...allowedTools, 'bash'];
      }
      // Inject custom tool descriptions as a skill prompt section
      const customToolsSection =
        `## Custom Tools\n\nYou have access to the following custom tools. Use bash to run them.\n\n` +
        customTools.promptSections.join('\n');
      skillPrompts.push(customToolsSection);
      this.env.log('info', `Loaded ${customTools.toolNames.length} custom tool(s): [${customTools.toolNames.join(', ')}]`);
    }

    // Determine which provider to use
    const providerKey = spec.agent?.provider || this.env.config.defaultProvider || 'claude-code';
    const cliProvider = this.getCliProvider(providerKey);
    if (cliProvider) {
      try {
        this.env.log('info', `Provider: ${cliProvider.providerName}`);
        const result = await cliProvider.executeSession(
          spec,
          this.env.config,
          enableTools,
          allowedTools,
          skillPrompts
        );
        this.env.log('debug', `Session done via ${cliProvider.providerName}`);
        return result;
      } catch (error) {
        this.env.log('error', `${providerKey} failed: ${error}`);
        this.env.log('warn', 'Falling back to mock session');
      }
    } else {
      this.env.log('warn', `Unknown provider "${providerKey}", using mock session`);
    }

    // Mock implementation as fallback
    const startTime = Date.now();
    await new Promise(resolve => setTimeout(resolve, 100));

    const result: SessionResult = {
      output: `[MOCK SESSION OUTPUT]\nPrompt: ${spec.prompt}\nContext: ${JSON.stringify(spec.context?.variables || {}, null, 2)}`,
      metadata: {
        model: spec.agent?.model || this.env.config.defaultModel,
        duration: Date.now() - startTime,
      },
    };

    this.env.log('debug', `Mock session completed`);
    return result;
  }

  /**
   * Execute a repeat block
   * Syntax: repeat N: ... or repeat N as i: ...
   */
  private async executeRepeatBlock(block: RepeatBlockNode): Promise<StatementResult> {
    this.env.trace(`Executing repeat block`);

    // Evaluate the count (can be number literal or variable)
    let count: number;
    if (block.count.type === 'NumberLiteral') {
      count = (block.count as NumberLiteralNode).value;
    } else {
      // It's an identifier - resolve the variable
      const countValue = await this.evaluateExpression(block.count);
      if (typeof countValue !== 'number') {
        throw new Error(`Repeat count must be a number, got ${typeof countValue}`);
      }
      count = countValue;
    }

    // Validate count
    if (count < 0) {
      throw new Error(`Repeat count must be non-negative, got ${count}`);
    }
    if (count > this.env.config.maxLoopIterations) {
      throw new Error(`Repeat count ${count} exceeds maximum ${this.env.config.maxLoopIterations}`);
    }

    this.env.log('info', `Repeating ${count} times`);

    // Execute the body count times
    for (let i = 0; i < count; i++) {
      // Create a new scope for this iteration
      this.env.contextManager.pushScope();

      try {
        // If there's an index variable, declare and set it
        if (block.indexVar) {
          // Declare the index variable (using a dummy location)
          this.env.contextManager.declareVariable(
            block.indexVar.name,
            i,
            false,
            block.indexVar.span
          );
        }

        this.env.trace(`Repeat iteration ${i + 1}/${count}`);

        // Execute each statement in the body
        for (const statement of block.body) {
          await this.executeStatement(statement);
        }
      } finally {
        // Always pop the scope, even if there's an error
        this.env.contextManager.popScope();
      }
    }

    return {};
  }

  /**
   * Execute a for-each block
   * Syntax: for item in items: ... or for item, i in items: ...
   */
  private async executeForEachBlock(block: ForEachBlockNode): Promise<StatementResult> {
    this.env.trace(`Executing for-each block`);

    // Check if parallel for-each
    if (block.isParallel) {
      this.env.log('warn', 'Parallel for-each is not yet fully implemented, executing sequentially');
      // TODO: Implement parallel execution
    }

    // Evaluate the collection
    const collection = await this.evaluateExpression(block.collection);

    // Ensure it's an array
    if (!Array.isArray(collection)) {
      throw new Error(`For-each requires an array, got ${typeof collection}`);
    }

    this.env.log('info', `Iterating over ${collection.length} items`);

    // Check iteration limit
    if (collection.length > this.env.config.maxLoopIterations) {
      throw new Error(`Collection size ${collection.length} exceeds maximum ${this.env.config.maxLoopIterations}`);
    }

    // Iterate over the collection
    for (let i = 0; i < collection.length; i++) {
      const item = collection[i];

      // Create a new scope for this iteration
      this.env.contextManager.pushScope();

      try {
        // Declare and set the item variable
        this.env.contextManager.declareVariable(
          block.itemVar.name,
          item,
          false,
          block.itemVar.span
        );

        // Declare and set the index variable if present
        if (block.indexVar) {
          this.env.contextManager.declareVariable(
            block.indexVar.name,
            i,
            false,
            block.indexVar.span
          );
        }

        this.env.trace(`For-each iteration ${i + 1}/${collection.length}, item: ${JSON.stringify(item)}`);

        // Execute each statement in the body
        for (const statement of block.body) {
          await this.executeStatement(statement);
        }
      } finally {
        // Always pop the scope, even if there's an error
        this.env.contextManager.popScope();
      }
    }

    return {};
  }

  /**
   * Execute an if statement
   * Syntax: if **condition**: ... elif **condition**: ... else: ...
   */
  private async executeIfStatement(statement: IfStatementNode): Promise<StatementResult> {
    this.env.trace(`Executing if statement`);

    // Evaluate the if condition using AI
    const ifCondition = await this.evaluateCondition(statement.condition);

    if (ifCondition) {
      this.env.log('info', 'If condition is true, executing then branch');
      this.env.contextManager.pushScope();
      try {
        for (const stmt of statement.thenBody) {
          await this.executeStatement(stmt);
        }
      } finally {
        this.env.contextManager.popScope();
      }
      return {};
    }

    // Check elif clauses
    for (const elifClause of statement.elseIfClauses) {
      const elifCondition = await this.evaluateCondition(elifClause.condition);
      if (elifCondition) {
        this.env.log('info', 'Elif condition is true, executing elif branch');
        this.env.contextManager.pushScope();
        try {
          for (const stmt of elifClause.body) {
            await this.executeStatement(stmt);
          }
        } finally {
          this.env.contextManager.popScope();
        }
        return {};
      }
    }

    // Execute else branch if present
    if (statement.elseBody) {
      this.env.log('info', 'All conditions false, executing else branch');
      this.env.contextManager.pushScope();
      try {
        for (const stmt of statement.elseBody) {
          await this.executeStatement(stmt);
        }
      } finally {
        this.env.contextManager.popScope();
      }
    } else {
      this.env.log('info', 'All conditions false, no else branch');
    }

    return {};
  }

  /**
   * Execute a choice block - AI selects the best option
   * Syntax:
   *   choice **which approach is best**:
   *     option "quick": ...
   *     option "thorough": ...
   */
  private async executeChoiceBlock(block: ChoiceBlockNode): Promise<StatementResult> {
    this.env.trace('Executing choice block');

    // Build a prompt for the AI to select the best option
    const optionLabels = await Promise.all(
      block.options.map(async (opt) => {
        if (opt.label.type === 'StringLiteral') {
          return opt.label.value;
        } else {
          return await this.evaluateInterpolatedString(opt.label);
        }
      })
    );

    this.env.log('info', `Choice block with options: ${optionLabels.join(', ')}`);

    // Create a prompt to ask AI which option to choose
    const criteriaText = block.criteria.expression;
    const optionsText = optionLabels.map((label, i) => `${i + 1}. ${label}`).join('\n');

    const selectionPrompt = `Given the criteria: "${criteriaText}"

Available options:
${optionsText}

Which option number is best? Respond with ONLY the number (1, 2, 3, etc.) and nothing else.`;

    this.env.log('debug', `Choice selection prompt: ${selectionPrompt}`);

    // Use the default model to make the selection
    let selectedIndex = 0;

    const defaultProvider = this.getCliProvider(this.env.config.conditionProvider ?? this.env.config.defaultProvider ?? 'claude-code');
    if (defaultProvider) {
      try {
        // Build a simple session spec for the choice selection
        const spec: SessionSpec = {
          agent: null,
          prompt: selectionPrompt,
          context: null,
        };

        const response = await defaultProvider.executeSession(
          spec,
          this.env.config,
          false, // No tools needed for simple selection
          []
        );

        const responseText = response.output.trim();
        this.env.log('debug', `AI selection response: ${responseText}`);

        // Extract the number from the response
        const match = responseText.match(/\b([1-9]\d*)\b/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= 1 && num <= block.options.length) {
            selectedIndex = num - 1;
          }
        }
      } catch (error) {
        this.env.log('warn', `Failed to get AI selection, defaulting to first option: ${error}`);
      }
    } else {
      this.env.log('warn', 'No provider configured, defaulting to first option');
    }

    const selectedOption = block.options[selectedIndex];
    const selectedLabel = optionLabels[selectedIndex];

    this.env.log('info', `AI selected option: "${selectedLabel}"`);

    // Execute the selected option's body
    this.env.contextManager.pushScope();
    try {
      for (const stmt of selectedOption.body) {
        await this.executeStatement(stmt);
      }
    } finally {
      this.env.contextManager.popScope();
    }

    return {};
  }

  /**
   * Capture current execution context for enriched discretion evaluation
   */
  private captureEnrichedContext(): EnrichedExecutionContext {
    const variablesMap = this.env.contextManager.getAllVariables();
    const variables: Record<string, RuntimeValue> = {};
    for (const [key, value] of variablesMap.entries()) {
      variables[key] = value;
    }

    // Get recent variable changes
    const recentChanges: string[] = [];
    const varEntries = Object.entries(variables).slice(-5);
    for (const [key, value] of varEntries) {
      recentChanges.push(`${key} = ${this.formatValueForContext(value)}`);
    }

    return {
      fileName: this.currentFileName,
      currentBlock: this.currentBlockStack.length > 0
        ? this.currentBlockStack[this.currentBlockStack.length - 1]
        : null,
      currentIteration: this.loopContext?.iteration ?? null,

      variables,
      recentChanges,

      recentEvents: this.executionEvents.slice(-10),
      executionPath: [...this.currentBlockStack],

      totalStatements: this.totalStatements,
      executedStatements: this.executedStatements,
      remainingStatements: Math.max(0, this.totalStatements - this.executedStatements),

      recentSessionOutputs: this.recentSessionOutputs.slice(-3),

      loopInfo: this.loopContext ? { ...this.loopContext } : null,
    };
  }

  /**
   * Format a runtime value for context display
   */
  private formatValueForContext(value: RuntimeValue, maxLength: number = 100): string {
    if (value === null || value === undefined) {
      return 'null';
    }

    // Extract output from SessionResult
    if (isSessionResult(value)) {
      const output = value.output;
      return output.length > maxLength
        ? output.substring(0, maxLength) + '...'
        : output;
    }

    const str = typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

    return str.length > maxLength
      ? str.substring(0, maxLength) + '...'
      : str;
  }

  /**
   * Build enriched prompt for discretion evaluation
   */
  private buildEnrichedDiscretionPrompt(
    condition: string,
    context: EnrichedExecutionContext
  ): string {
    let prompt = `You are evaluating a condition in an AI workflow execution.

CONDITION TO EVALUATE:
"${condition}"

EXECUTION CONTEXT:
`;

    // Add current execution state
    if (context.currentBlock) {
      prompt += `- Current block: ${context.currentBlock}\n`;
    }

    if (context.currentIteration !== null) {
      prompt += `- Current iteration: ${context.currentIteration}\n`;
    }

    // Add loop context if available
    if (context.loopInfo) {
      prompt += `- Loop iteration: ${context.loopInfo.iteration}`;
      if (context.loopInfo.maxIterations) {
        prompt += ` / ${context.loopInfo.maxIterations}`;
      }
      prompt += `\n`;

      if (context.loopInfo.previousResults.length > 0) {
        prompt += `- Previous loop results: ${context.loopInfo.previousResults.slice(-3).map(r =>
          this.formatValueForContext(r, 50)
        ).join(', ')}\n`;
      }
    }

    // Add progress info
    prompt += `- Progress: ${context.executedStatements}/${context.totalStatements} statements executed\n`;

    // Add recent variable changes
    if (context.recentChanges.length > 0) {
      prompt += `\nRECENT VARIABLE CHANGES:\n`;
      context.recentChanges.forEach(change => {
        prompt += `  ${change}\n`;
      });
    }

    // Add current variables
    prompt += `\nCURRENT VARIABLES:\n`;
    const varEntries = Object.entries(context.variables);
    if (varEntries.length > 0) {
      varEntries.forEach(([key, value]) => {
        prompt += `  ${key} = ${this.formatValueForContext(value, 80)}\n`;
      });
    } else {
      prompt += `  (no variables defined)\n`;
    }

    // Add recent session outputs
    if (context.recentSessionOutputs.length > 0) {
      prompt += `\nRECENT AI SESSION OUTPUTS:\n`;
      context.recentSessionOutputs.forEach((output, i) => {
        prompt += `  [${i + 1}] ${this.formatValueForContext(output, 100)}\n`;
      });
    }

    // Add recent execution events
    if (context.recentEvents.length > 0) {
      prompt += `\nRECENT EXECUTION HISTORY:\n`;
      context.recentEvents.forEach(event => {
        prompt += `  [${event.type}] ${event.description}\n`;
      });
    }

    prompt += `\nBased on the FULL CONTEXT above, evaluate whether the condition is TRUE or FALSE.
Consider:
- The overall goal and progress of the workflow
- Whether continuing makes sense given the current state
- Any patterns or trends in the execution history
- The quality and completeness of recent results

Respond with ONLY "true" or "false" (one word, lowercase).`;

    return prompt;
  }

  /**
   * Evaluate a discretion condition using AI with enriched context
   * Returns true or false
   */
  private async evaluateCondition(condition: DiscretionNode): Promise<boolean> {
    this.env.trace(`Evaluating condition: ${condition.expression}`);

    const conditionProvider = this.getCliProvider(this.env.config.conditionProvider ?? this.env.config.defaultProvider ?? 'claude-code');
    if (!conditionProvider) {
      this.env.log('warn', 'No provider available, conditions always evaluate to true');
      return true;
    }

    // Capture enriched execution context
    const enrichedContext = this.captureEnrichedContext();

    // Build enriched prompt
    const enrichedPrompt = this.buildEnrichedDiscretionPrompt(
      condition.expression,
      enrichedContext
    );

    this.env.log('debug', `Enriched discretion prompt (${enrichedPrompt.length} chars)`);

    // Create a session spec to ask AI to evaluate the condition
    const contextSnapshot = this.env.contextManager.captureContext();
    const spec: SessionSpec = {
      prompt: enrichedPrompt,
      agent: {
        name: 'condition_evaluator',
        model: this.env.config.defaultModel,
        skills: [],
        tools: [],
        permissions: {},
      },
      context: contextSnapshot,
    };

    // Record this as an event
    this.addExecutionEvent('condition', `Evaluating: ${condition.expression}`);

    const result = await conditionProvider.executeSession(spec, this.env.config, false, []);
    const output = result.output.toLowerCase().trim();

    // Parse the AI response
    const isTrue = output.includes('true');
    const isFalse = output.includes('false');

    let finalResult: boolean;
    if (isTrue && !isFalse) {
      finalResult = true;
    } else if (isFalse && !isTrue) {
      finalResult = false;
    } else {
      this.env.log('warn', `AI returned ambiguous condition result: "${output}", defaulting to false`);
      finalResult = false;
    }

    // Record the result
    this.addExecutionEvent('condition', `Result: ${finalResult}`);

    return finalResult;
  }

  /**
   * Add an execution event to history
   */
  private addExecutionEvent(type: ExecutionEvent['type'], description: string, result?: any) {
    this.executionEvents.push({
      type,
      description,
      timestamp: Date.now(),
      result,
    });

    // Keep only last 50 events to avoid memory issues
    if (this.executionEvents.length > 50) {
      this.executionEvents.shift();
    }
  }

  /**
   * Track a completed session result in recent/all output arrays
   */
  private trackSessionOutput(result: SessionResult): void {
    this.recentSessionOutputs.push(result.output);
    if (this.recentSessionOutputs.length > 10) {
      this.recentSessionOutputs.shift();
    }
    this.allSessionOutputs.push(result);
    if (this.allSessionOutputs.length > 200) {
      this.allSessionOutputs.shift();
    }
  }

  /**
   * Execute a loop block
   * Syntax: loop:, loop until **condition**:, loop while **condition**:
   */
  private async executeLoopBlock(block: LoopBlockNode): Promise<StatementResult> {
    this.env.trace(`Executing loop block (variant: ${block.variant})`);

    // Determine max iterations
    let maxIterations = this.env.config.maxLoopIterations;
    if (block.maxIterations) {
      maxIterations = (block.maxIterations as NumberLiteralNode).value;
    }

    this.env.log('info', `Loop starting (max: ${maxIterations})`);

    let iteration = 0;
    let shouldContinue = true;
    const loopResults: any[] = [];

    // Set loop context for enriched evaluation
    this.loopContext = {
      iteration: 0,
      maxIterations,
      previousResults: [],
    };

    while (iteration < maxIterations && shouldContinue) {
      // Update loop context
      this.loopContext.iteration = iteration;
      this.loopContext.previousResults = loopResults;

      // Create a new scope for this iteration
      this.env.contextManager.pushScope();

      try {
        // If there's an iteration variable, declare it
        if (block.iterationVar) {
          this.env.contextManager.declareVariable(
            block.iterationVar.name,
            iteration,
            false,
            block.iterationVar.span
          );
        }

        // Check condition for until/while variants
        if (block.condition) {
          const conditionResult = await this.evaluateCondition(block.condition);

          if (block.variant === 'until' && conditionResult) {
            // Exit when condition becomes true
            this.env.log('info', `Loop until condition met at iteration ${iteration}`);
            shouldContinue = false;
            // Don't execute body, just clean up scope
            continue;
          } else if (block.variant === 'while' && !conditionResult) {
            // Exit when condition becomes false
            this.env.log('info', `Loop while condition false at iteration ${iteration}`);
            shouldContinue = false;
            // Don't execute body, just clean up scope
            continue;
          }
        }

        this.env.trace(`Loop iteration ${iteration + 1}`);

        // Execute the body and capture result
        let iterationResult: any = null;
        for (const statement of block.body) {
          const result = await this.executeStatement(statement);
          if (result.value !== undefined) {
            iterationResult = result.value;
          }
        }

        // Store iteration result
        loopResults.push(iterationResult);

        iteration++;
      } finally {
        this.env.contextManager.popScope();
      }
    }

    // Clear loop context
    this.loopContext = null;

    if (iteration >= maxIterations) {
      this.env.log('warn', `Loop terminated after reaching max iterations (${maxIterations})`);
    }

    return {};
  }

  /**
   * Execute a try/catch/finally block
   */
  private async executeTryBlock(block: TryBlockNode): Promise<StatementResult> {
    this.env.trace('Executing try/catch block');

    let error: Error | null = null;

    // Execute try body
    try {
      this.env.log('info', 'Executing try block');
      this.env.contextManager.pushScope();

      try {
        for (const statement of block.tryBody) {
          await this.executeStatement(statement);
        }
      } finally {
        this.env.contextManager.popScope();
      }
    } catch (err) {
      error = err as Error;
      this.env.log('warn', `Error caught in try block: ${error.message}`);

      // Execute catch body if present
      if (block.catchBody) {
        this.env.log('info', 'Executing catch block');
        this.env.contextManager.pushScope();

        try {
          // If there's an error variable, declare it
          if (block.errorVar) {
            const errorInfo = {
              message: error.message,
              type: error.name || 'Error',
              stack: error.stack || '',
            };
            this.env.contextManager.declareVariable(
              block.errorVar.name,
              errorInfo,
              false,
              block.errorVar.span
            );
          }

          for (const statement of block.catchBody) {
            await this.executeStatement(statement);
          }

          // Error was handled
          error = null;
        } finally {
          this.env.contextManager.popScope();
        }
      }
    } finally {
      // Execute finally body if present (always runs)
      if (block.finallyBody) {
        this.env.log('info', 'Executing finally block');
        this.env.contextManager.pushScope();

        try {
          for (const statement of block.finallyBody) {
            await this.executeStatement(statement);
          }
        } finally {
          this.env.contextManager.popScope();
        }
      }
    }

    // Re-throw error if it wasn't handled
    if (error) {
      throw error;
    }

    return {};
  }

  /**
   * Execute an ask statement — prompt the user for input via stdin
   * Syntax: ask <varname>: "question"
   */
  private async executeAskStatement(statement: AskStatementNode): Promise<StatementResult> {
    const varName = statement.variable.name;

    // Resume: if the variable was restored from a previous run's state, skip prompting
    if (this.env.contextManager.hasVariable(varName)) {
      const existing = this.env.contextManager.getVariable(varName);
      this.env.log('info', `[RESUMED] ask ${varName} = "${existing}" (from saved state)`);
      return { value: existing };
    }

    const promptText = await this.evaluateExpression(statement.prompt) as string;

    const answer = await new Promise<string>((resolve) => {
      process.stdout.write(`${BOLD}${CYAN}? ${promptText}${RESET} `);

      // If we already have a buffered line, return it immediately
      if (this.stdinLineBuffer.length > 0) {
        resolve(this.stdinLineBuffer.shift()!);
        return;
      }

      // Read from stdin, buffering extra lines for subsequent asks
      process.stdin.setEncoding('utf-8');
      process.stdin.resume();
      const onData = (chunk: unknown) => {
        this.stdinRemainder += String(chunk);
        const lines = this.stdinRemainder.split('\n');
        // Last element is incomplete fragment (or '' if chunk ended with \n)
        this.stdinRemainder = lines.pop()!;
        this.stdinLineBuffer.push(...lines);
        if (this.stdinLineBuffer.length > 0) {
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          resolve(this.stdinLineBuffer.shift()!.trim());
        }
      };
      const onEnd = () => {
        this.stdinEnded = true;
        // Flush any remaining data without a trailing newline
        if (this.stdinRemainder) {
          this.stdinLineBuffer.push(this.stdinRemainder);
          this.stdinRemainder = '';
        }
        process.stdin.removeListener('data', onData);
        resolve((this.stdinLineBuffer.shift() ?? '').trim());
      };
      process.stdin.once('end', onEnd);
      process.stdin.on('data', onData);
    });

    this.env.log('info', `ask ${varName} = ${GREEN}"${answer}"${RESET}`);
    this.env.contextManager.declareVariable(varName, answer, false, statement.span);

    // Persist immediately so resume can skip re-asking even if no session completes yet
    if (this.stateStore && this.currentRunId !== null) {
      this.stateStore.saveUserInput(this.currentRunId, varName, answer);
    }

    return { value: answer };
  }

  /**
   * Execute a skill invocation
   * Syntax: skill <name> [param=value ...] [-> var]
   *
   * Invokes the named Claude Code skill (/skillname) as a session.
   * Parameters are passed as context to the skill prompt.
   * If an outputVar or binding captures the result, it is stored in the environment.
   */
  private async executeSkillInvocation(statement: SkillInvocationNode): Promise<StatementResult> {
    const skillName = statement.skillName.name;
    this.env.log('info', `Invoking skill: /${skillName}`);

    // Resolve parameter values
    const resolvedParams: Record<string, string> = {};
    for (const param of statement.params) {
      const value = await this.evaluateExpression(param.value);
      // Extract string from SessionResult if needed
      if (isSessionResult(value)) {
        resolvedParams[param.name.name] = String(value.output);
      } else {
        resolvedParams[param.name.name] = value !== null && value !== undefined ? String(value) : '';
      }
    }

    // Build the skill prompt: /<skillname>\n\nparam: value\n...
    let prompt = `/${skillName}`;
    for (const [key, val] of Object.entries(resolvedParams)) {
      prompt += `\n\n${key}:\n${val}`;
    }

    // Build a session spec using a minimal claude-code agent
    const spec: SessionSpec = {
      prompt,
      context: null,
      agent: {
        name: 'skill-runner',
        model: this.env.config.defaultModel,
        provider: 'claude-code',
        skills: [],
        tools: [],
        permissions: {},
      },
    };

    const result = await this.executeSession(spec);

    // Track output
    this.trackSessionOutput(result);

    // Assign to outputVar if specified (statement form: skill ... -> varname)
    if (statement.outputVar) {
      const varName = statement.outputVar.name;
      this.env.contextManager.declareVariable(varName, result, false, statement.span);
    }

    return { value: result };
  }

  private async executeThrowStatement(statement: ThrowStatementNode): Promise<StatementResult> {
    this.env.trace('Executing throw statement');

    let message = 'Error thrown';

    if (statement.message) {
      // Evaluate the message expression (handles both literals and interpolated strings)
      const evaluated = await this.evaluateExpression(statement.message);
      message = String(evaluated);
    }

    this.env.log('error', `Throwing error: ${message}`);
    throw new Error(message);
  }

  /**
   * Execute a return statement
   * Throws a ReturnSignal to be caught by the enclosing block
   */
  private async executeReturnStatement(statement: ReturnStatementNode): Promise<StatementResult> {
    this.env.trace('Executing return statement');

    let value: RuntimeValue = null;

    if (statement.value) {
      value = await this.evaluateExpression(statement.value);
    }

    this.env.log('info', `Returning value: ${JSON.stringify(value)}`);

    // Throw a special signal to indicate return
    throw new ReturnSignal(value);
  }

  /**
   * Execute a parallel block
   * Runs multiple sessions concurrently
   */
  private async executeParallelBlock(block: ParallelBlockNode): Promise<StatementResult> {
    this.env.trace('Executing parallel block');

    // Get join strategy (default: "all")
    const joinStrategy = block.joinStrategy
      ? String(await this.evaluateExpression(block.joinStrategy))
      : 'all';
    const anyCount = block.anyCount ? (block.anyCount as NumberLiteralNode).value : 1;
    const onFail = block.onFail
      ? String(await this.evaluateExpression(block.onFail))
      : 'fail-fast';

    this.env.log('info', `Parallel block starting (strategy: ${joinStrategy}, onFail: ${onFail})`);

    // Create a new scope for the parallel block
    this.env.contextManager.pushScope();

    // Collect let-binding metadata so we can promote results to the parent scope
    type LetResult = { value: RuntimeValue; span: import('../parser/tokens').SourceSpan };
    const results: Map<string, LetResult> = new Map();
    const errors: Error[] = [];

    try {
      // Collect all statements to execute
      const tasks: Promise<void>[] = [];

      // Execute each statement in the body concurrently
      for (const statement of block.body) {
        const task = (async () => {
          try {
            // Each parallel task gets its own scope (but shares the parent)
            // Note: For full isolation, we'd need to clone the context
            await this.executeStatement(statement);

            // Capture let-bindings and assignments for parent-scope promotion
            if (statement.type === 'LetBinding') {
              const letStmt = statement as LetBindingNode;
              const value = this.env.contextManager.getVariable(letStmt.name.name);
              results.set(letStmt.name.name, { value, span: letStmt.span });
            } else if (statement.type === 'Assignment') {
              const assignStmt = statement as AssignmentNode;
              const value = this.env.contextManager.getVariable(assignStmt.name.name);
              results.set(assignStmt.name.name, { value, span: assignStmt.name.span });
            }
          } catch (err) {
            const error = err as Error;
            errors.push(error);

            // Handle onFail strategies
            if (onFail === 'fail-fast') {
              throw error; // Propagate immediately
            } else if (onFail === 'continue') {
              this.env.log('warn', `Parallel task failed, continuing: ${error.message}`);
            } else if (onFail === 'ignore') {
              // Silently ignore
            }
          }
        })();

        tasks.push(task);

        // For "first" strategy, we can short-circuit
        if (joinStrategy === 'first' && tasks.length > 0) {
          // Wait for the first to complete
          await Promise.race(tasks);
          break;
        }
      }

      // Wait based on join strategy
      if (joinStrategy === 'all') {
        // Wait for all tasks
        await Promise.all(tasks);
      } else if (joinStrategy === 'first') {
        // Wait for first to complete (already handled above)
        await Promise.race(tasks);
      } else if (joinStrategy === 'any') {
        // Wait for N tasks to complete
        const completedCount = Math.min(anyCount, tasks.length);
        let resolved = 0;
        await new Promise<void>((res) => {
          for (const task of tasks) {
            task.then(() => { if (++resolved >= completedCount) res(); },
                      () => { if (++resolved >= completedCount) res(); });
          }
        });
      }

      // Check for errors
      if (errors.length > 0 && onFail === 'fail-fast') {
        throw errors[0];
      }

      this.env.log('info', `Parallel block completed (${results.size} results, ${errors.length} errors)`);

      return {};
    } finally {
      // Pop the parallel scope before promoting let-binding results to parent
      this.env.contextManager.popScope();

      // Declare each captured let-binding in the now-current (parent) scope
      for (const [name, { value, span }] of results) {
        if (this.env.contextManager.hasVariable(name)) {
          this.env.contextManager.setVariable(name, value);
        } else {
          this.env.contextManager.declareVariable(name, value, false, span);
        }
      }
    }
  }

  /**
   * Execute a block definition
   */
  private async executeBlockDefinition(block: BlockDefinitionNode): Promise<StatementResult> {
    const blockName = block.name.name;
    this.env.log('info', `Defining block: ${blockName}`);

    // Store the block definition
    this.blocks.set(blockName, block);

    this.env.log('debug', `Block '${blockName}' defined with ${block.parameters.length} parameter(s)`);

    return {};
  }

  /**
   * Execute a do block
   */
  private async executeDoBlock(doBlock: DoBlockNode): Promise<StatementResult> {
    // Check if it's a named block invocation
    if (doBlock.name) {
      const blockName = doBlock.name.name;
      this.env.log('info', `Invoking block: ${blockName}`);

      // Get the block definition
      const blockDef = this.blocks.get(blockName);
      if (!blockDef) {
        throw new Error(`Block '${blockName}' is not defined`);
      }

      // Create new scope for the block
      this.env.contextManager.pushScope();

      try {
        // Bind parameters
        if (blockDef.parameters.length !== doBlock.arguments.length) {
          throw new Error(`Block '${blockName}' expects ${blockDef.parameters.length} argument(s) but got ${doBlock.arguments.length}`);
        }

        for (let i = 0; i < blockDef.parameters.length; i++) {
          const paramName = blockDef.parameters[i].name;
          const argValue = await this.evaluateExpression(doBlock.arguments[i]);
          this.env.contextManager.declareVariable(
            paramName,
            argValue,
            false,
            blockDef.parameters[i].span
          );
        }

        // Execute the block body
        try {
          for (const statement of blockDef.body) {
            await this.executeStatement(statement);
          }
          // If no return statement, return null
          return { value: null };
        } catch (error) {
          // Check if this is a return signal
          if (error instanceof ReturnSignal) {
            this.env.log('info', `Block '${blockName}' returned: ${JSON.stringify(error.value)}`);
            return { value: error.value };
          }
          // Otherwise, re-throw the error
          throw error;
        }
      } finally {
        this.env.contextManager.popScope();
      }
    } else {
      // Anonymous do block - just execute the body
      this.env.log('info', 'Executing anonymous do block');

      this.env.contextManager.pushScope();

      try {
        try {
          for (const statement of doBlock.body) {
            await this.executeStatement(statement);
          }
          // If no return statement, return null
          return { value: null };
        } catch (error) {
          // Check if this is a return signal
          if (error instanceof ReturnSignal) {
            this.env.log('info', `Anonymous block returned: ${JSON.stringify(error.value)}`);
            return { value: error.value };
          }
          // Otherwise, re-throw the error
          throw error;
        }
      } finally {
        this.env.contextManager.popScope();
      }
    }
  }

  /**
   * Evaluate a pipe expression (Pipeline operations)
   */
  private async evaluatePipeExpression(pipe: PipeExpressionNode): Promise<RuntimeValue> {
    this.env.log('info', 'Evaluating pipe expression');

    // Evaluate the input
    let currentValue = await this.evaluateExpression(pipe.input);

    // Apply each operation in the pipeline
    for (const operation of pipe.operations) {
      currentValue = await this.executePipeOperation(operation, currentValue);
    }

    return currentValue;
  }

  /**
   * Evaluate an arrow expression (sequential composition)
   * Syntax: expression -> expression -> expression
   * Each expression receives the result of the previous one as context
   */
  private async evaluateArrowExpression(arrow: ArrowExpressionNode): Promise<RuntimeValue> {
    this.env.log('info', 'Evaluating arrow expression (chain)');

    // Evaluate the left side first
    const leftResult = await this.evaluateExpression(arrow.left);
    this.env.log('debug', `Arrow left result: ${JSON.stringify(leftResult)}`);

    // Store the left result in a special variable that the right side can access
    // Use a new scope to avoid polluting the outer scope
    this.env.contextManager.pushScope();

    try {
      // Make the left result available as "result" or "_" for the right expression
      this.env.contextManager.declareVariable(
        'result',
        leftResult,
        false,
        arrow.span
      );
      this.env.contextManager.declareVariable(
        '_',
        leftResult,
        false,
        arrow.span
      );

      // Evaluate the right side (which can access {result} or {_})
      const rightResult = await this.evaluateExpression(arrow.right);
      this.env.log('debug', `Arrow right result: ${JSON.stringify(rightResult)}`);

      return rightResult;
    } finally {
      this.env.contextManager.popScope();
    }
  }

  /**
   * Execute a single pipeline operation
   */
  private async executePipeOperation(
    operation: PipeOperationNode,
    input: RuntimeValue
  ): Promise<RuntimeValue> {
    // Ensure input is an array for most operations
    if (operation.operator !== 'reduce' && !Array.isArray(input)) {
      throw new Error(`Pipeline ${operation.operator} requires an array input, got ${typeof input}`);
    }

    switch (operation.operator) {
      case 'map':
        return await this.executePipeMap(operation, input as RuntimeValue[]);

      case 'filter':
        return await this.executePipeFilter(operation, input as RuntimeValue[]);

      case 'reduce':
        if (!Array.isArray(input)) {
          throw new Error(`Pipeline reduce requires an array input, got ${typeof input}`);
        }
        return await this.executePipeReduce(operation, input as RuntimeValue[]);

      case 'pmap':
        return await this.executePipeParallelMap(operation, input as RuntimeValue[]);

      default:
        throw new Error(`Unsupported pipeline operator: ${(operation as any).operator}`);
    }
  }

  /**
   * Execute pipeline map operation
   */
  private async executePipeMap(
    operation: PipeOperationNode,
    input: RuntimeValue[]
  ): Promise<RuntimeValue[]> {
    this.env.log('info', `Pipeline map over ${input.length} items`);

    const results: RuntimeValue[] = [];

    for (let i = 0; i < input.length; i++) {
      const item = input[i];

      // Create new scope for this iteration
      this.env.contextManager.pushScope();

      try {
        // Declare the implicit 'item' variable
        this.env.contextManager.declareVariable(
          'item',
          item,
          false,
          operation.span
        );

        // Execute the body (should contain a session statement or expression)
        let result: RuntimeValue = null;
        for (const statement of operation.body) {
          const stmtResult = await this.executeStatement(statement);
          if (stmtResult.value !== undefined) {
            result = stmtResult.value;
          }
        }

        results.push(result);
      } finally {
        this.env.contextManager.popScope();
      }
    }

    this.env.log('info', `Pipeline map completed with ${results.length} results`);
    return results;
  }

  /**
   * Execute pipeline filter operation
   */
  private async executePipeFilter(
    operation: PipeOperationNode,
    input: RuntimeValue[]
  ): Promise<RuntimeValue[]> {
    this.env.log('info', `Pipeline filter over ${input.length} items`);

    const results: RuntimeValue[] = [];

    for (let i = 0; i < input.length; i++) {
      const item = input[i];

      // Create new scope for this iteration
      this.env.contextManager.pushScope();

      try {
        // Declare the implicit 'item' variable
        this.env.contextManager.declareVariable(
          'item',
          item,
          false,
          operation.span
        );

        // Execute the body - should contain a condition evaluation
        let shouldInclude = false;

        for (const statement of operation.body) {
          // If the statement contains a discretion, evaluate it
          if (statement.type === 'IfStatement') {
            const ifStmt = statement as IfStatementNode;
            if (ifStmt.condition) {
              shouldInclude = await this.evaluateCondition(ifStmt.condition);
            }
          } else {
            // Try to execute and get a boolean result
            const result = await this.executeStatement(statement);
            if (typeof result.value === 'boolean') {
              shouldInclude = result.value;
            }
          }
        }

        if (shouldInclude) {
          results.push(item);
        }
      } finally {
        this.env.contextManager.popScope();
      }
    }

    this.env.log('info', `Pipeline filter completed with ${results.length}/${input.length} items`);
    return results;
  }

  /**
   * Execute pipeline reduce operation
   */
  private async executePipeReduce(
    operation: PipeOperationNode,
    input: RuntimeValue[]
  ): Promise<RuntimeValue> {
    this.env.log('info', `Pipeline reduce over ${input.length} items`);

    if (!operation.accVar || !operation.itemVar) {
      throw new Error('Pipeline reduce requires accumulator and item variable names');
    }

    // Get initial accumulator value (should be passed as first parameter)
    // For now, we'll use the first element or null
    let accumulator: RuntimeValue = input.length > 0 ? input[0] : null;

    for (let i = 1; i < input.length; i++) {
      const item = input[i];

      // Create new scope for this iteration
      this.env.contextManager.pushScope();

      try {
        // Declare accumulator and item variables
        this.env.contextManager.declareVariable(
          operation.accVar.name,
          accumulator,
          false,
          operation.accVar.span
        );

        this.env.contextManager.declareVariable(
          operation.itemVar.name,
          item,
          false,
          operation.itemVar.span
        );

        // Execute the body
        for (const statement of operation.body) {
          const result = await this.executeStatement(statement);
          if (result.value !== undefined) {
            accumulator = result.value;
          }
        }
      } finally {
        this.env.contextManager.popScope();
      }
    }

    this.env.log('info', `Pipeline reduce completed with result: ${JSON.stringify(accumulator)}`);
    return accumulator;
  }

  /**
   * Execute pipeline parallel map operation
   */
  private async executePipeParallelMap(
    operation: PipeOperationNode,
    input: RuntimeValue[]
  ): Promise<RuntimeValue[]> {
    this.env.log('info', `Pipeline pmap over ${input.length} items (parallel)`);

    const tasks: Promise<RuntimeValue>[] = [];

    for (let i = 0; i < input.length; i++) {
      const item = input[i];

      const task = (async () => {
        // Create new scope for this iteration
        this.env.contextManager.pushScope();

        try {
          // Declare the implicit 'item' variable
          this.env.contextManager.declareVariable(
            'item',
            item,
            false,
            operation.span
          );

          // Execute the body
          let result: RuntimeValue = null;
          for (const statement of operation.body) {
            const stmtResult = await this.executeStatement(statement);
            if (stmtResult.value !== undefined) {
              result = stmtResult.value;
            }
          }

          return result;
        } finally {
          this.env.contextManager.popScope();
        }
      })();

      tasks.push(task);
    }

    // Wait for all tasks to complete
    const results = await Promise.all(tasks);

    this.env.log('info', `Pipeline pmap completed with ${results.length} results`);
    return results;
  }
}
