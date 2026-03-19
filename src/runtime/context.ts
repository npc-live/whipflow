/**
 * Context Manager - handles variable scoping and context passing
 */

import { SourceSpan } from '../parser/tokens';
import {
  RuntimeValue,
  Variable,
  ContextSnapshot,
  ExecutionError,
} from './types';

/**
 * Scope for variables
 */
class Scope {
  private variables: Map<string, Variable> = new Map();
  private parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  /**
   * Declare a new variable in this scope
   */
  declare(name: string, value: RuntimeValue, isConst: boolean, location: SourceSpan): void {
    if (this.variables.has(name)) {
      throw new Error(`Variable '${name}' is already declared in this scope`);
    }

    this.variables.set(name, {
      name,
      value,
      isConst,
      declaredAt: location,
    });
  }

  /**
   * Get a variable from this scope or parent scopes
   */
  get(name: string): Variable | undefined {
    const variable = this.variables.get(name);
    if (variable !== undefined) {
      return variable;
    }

    if (this.parent) {
      return this.parent.get(name);
    }

    return undefined;
  }

  /**
   * Set a variable's value (must be already declared and not const)
   */
  set(name: string, value: RuntimeValue): void {
    const variable = this.variables.get(name);
    if (variable) {
      if (variable.isConst) {
        throw new Error(`Cannot reassign const variable '${name}'`);
      }
      variable.value = value;
      return;
    }

    if (this.parent) {
      this.parent.set(name, value);
      return;
    }

    throw new Error(`Variable '${name}' is not declared`);
  }

  /**
   * Check if a variable exists in this scope or parent scopes
   */
  has(name: string): boolean {
    if (this.variables.has(name)) {
      return true;
    }

    if (this.parent) {
      return this.parent.has(name);
    }

    return false;
  }

  /**
   * Get all variables in this scope (for debugging)
   */
  getAll(): Map<string, Variable> {
    return new Map(this.variables);
  }
}

/**
 * Context Manager - manages variable scopes
 */
export class ContextManager {
  private scopeStack: Scope[] = [];
  private executionPath: string[] = [];

  constructor() {
    // Start with global scope
    this.pushScope();
  }

  /**
   * Push a new scope onto the stack
   */
  pushScope(): void {
    const parent = this.scopeStack.length > 0 ? this.currentScope : null;
    this.scopeStack.push(new Scope(parent));
  }

  /**
   * Pop the current scope from the stack
   */
  popScope(): void {
    if (this.scopeStack.length <= 1) {
      throw new Error('Cannot pop global scope');
    }
    this.scopeStack.pop();
  }

  /**
   * Get the current scope
   */
  private get currentScope(): Scope {
    if (this.scopeStack.length === 0) {
      throw new Error('No scope available');
    }
    return this.scopeStack[this.scopeStack.length - 1];
  }

  /**
   * Declare a new variable
   */
  declareVariable(
    name: string,
    value: RuntimeValue,
    isConst: boolean,
    location: SourceSpan
  ): void {
    this.currentScope.declare(name, value, isConst, location);
  }

  /**
   * Get a variable's value
   */
  getVariable(name: string): RuntimeValue {
    const variable = this.currentScope.get(name);
    if (!variable) {
      throw new Error(`Variable '${name}' is not defined`);
    }
    return variable.value;
  }

  /**
   * Set a variable's value
   */
  setVariable(name: string, value: RuntimeValue): void {
    this.currentScope.set(name, value);
  }

  /**
   * Check if a variable exists
   */
  hasVariable(name: string): boolean {
    return this.currentScope.has(name);
  }

  /**
   * Add to execution path (for debugging and context)
   */
  addToExecutionPath(description: string): void {
    this.executionPath.push(description);
  }

  /**
   * Capture context snapshot for passing to sessions
   */
  captureContext(variableNames?: string[]): ContextSnapshot {
    const variables: Record<string, RuntimeValue> = {};

    if (variableNames && variableNames.length > 0) {
      // Capture specific variables
      for (const name of variableNames) {
        if (this.hasVariable(name)) {
          variables[name] = this.getVariable(name);
        }
      }
    } else {
      // Capture all variables from all scopes
      for (const scope of this.scopeStack) {
        const scopeVars = scope.getAll();
        for (const [name, variable] of scopeVars) {
          variables[name] = variable.value;
        }
      }
    }

    return {
      variables,
      metadata: {
        timestamp: Date.now(),
        executionPath: [...this.executionPath],
      },
    };
  }

  /**
   * Get all variables (for debugging)
   */
  getAllVariables(): Map<string, RuntimeValue> {
    const allVars = new Map<string, RuntimeValue>();

    for (const scope of this.scopeStack) {
      const scopeVars = scope.getAll();
      for (const [name, variable] of scopeVars) {
        allVars.set(name, variable.value);
      }
    }

    return allVars;
  }

  /**
   * Get execution path
   */
  getExecutionPath(): string[] {
    return [...this.executionPath];
  }

  /**
   * Reset the context manager
   */
  reset(): void {
    this.scopeStack = [];
    this.executionPath = [];
    this.pushScope(); // Re-create global scope
  }
}
