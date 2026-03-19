/**
 * OpenRouter API Integration
 * Provides real AI model execution via OpenRouter
 */

import { SessionResult, SessionSpec, RuntimeConfig, isSessionResult } from './types';
import { ToolRegistry, ToolCallResult } from './tools';

/**
 * OpenRouter model mapping
 * Using Qwen models - fast and capable
 */
const MODEL_MAP = {
  opus: 'qwen/qwen3.5-27b', // Qwen 3.5 27B as high-end option
  sonnet: 'qwen/qwen3.5-27b', // Qwen 3.5 27B as mid-tier option
  haiku: 'qwen/qwen3.5-27b', // Qwen 3.5 27B as fast option
};

/**
 * OpenRouter API client
 */
export class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string = 'https://openrouter.ai/api/v1';
  private toolRegistry: ToolRegistry;

  constructor(apiKey: string, toolRegistry?: ToolRegistry) {
    if (!apiKey) {
      throw new Error('OpenRouter API key is required');
    }
    this.apiKey = apiKey;
    this.toolRegistry = toolRegistry || new ToolRegistry();
  }

  /**
   * Classify error type for better handling
   */
  private classifyError(error: any): {
    type: 'rate_limit' | 'timeout' | 'auth' | 'model_unavailable' | 'tool_error' | 'network' | 'unknown';
    message: string;
    retryable: boolean;
  } {
    const message = error.message || String(error);

    if (message.includes('429') || message.includes('rate_limit') || message.includes('Too Many Requests')) {
      return { type: 'rate_limit', message, retryable: true };
    }

    if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
      return { type: 'timeout', message, retryable: true };
    }

    if (message.includes('401') || message.includes('403') || message.includes('Unauthorized') || message.includes('Forbidden')) {
      return { type: 'auth', message, retryable: false };
    }

    if (message.includes('404') || message.includes('model') || message.includes('not available')) {
      return { type: 'model_unavailable', message, retryable: false };
    }

    if (message.includes('Tool execution failed') || message.includes('tool_call')) {
      return { type: 'tool_error', message, retryable: false };
    }

    if (message.includes('fetch failed') || message.includes('ECONNREFUSED') || message.includes('network')) {
      return { type: 'network', message, retryable: true };
    }

    return { type: 'unknown', message, retryable: false };
  }

  /**
   * Execute API call with retry logic
   */
  private async callAPIWithRetry(
    requestBody: any,
    maxRetries: number = 2
  ): Promise<any> {
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/harness-farm/whipflow',
            'X-Title': 'whipflow',
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const error = new Error(
            `OpenRouter API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`
          );

          const classification = this.classifyError(error);

          if (!classification.retryable || attempt === maxRetries) {
            throw error;
          }

          // Retryable error - wait and retry
          const waitTime = classification.type === 'rate_limit' ? 5000 : 2000;
          console.warn(`[OpenRouter] ${classification.type} error, retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          lastError = error;
          continue;
        }

        return await response.json();
      } catch (error) {
        const classification = this.classifyError(error);

        if (!classification.retryable || attempt === maxRetries) {
          throw error;
        }

        const waitTime = 2000;
        console.warn(`[OpenRouter] ${classification.type} error, retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        lastError = error;
      }
    }

    throw lastError;
  }

  /**
   * Execute a session using OpenRouter (with optional tool calling)
   */
  async executeSession(
    spec: SessionSpec,
    config: RuntimeConfig,
    enableTools: boolean = false,
    allowedTools?: string[],
    skillPrompts?: string[]
  ): Promise<SessionResult> {
    const startTime = Date.now();

    // Determine which model to use
    const modelKey = spec.agent?.model || config.defaultModel;
    const modelId = MODEL_MAP[modelKey];

    if (!modelId) {
      throw new Error(`Unknown model: ${modelKey}`);
    }

    // Build the prompt with context
    const fullPrompt = this.buildPromptWithContext(spec);

    // Determine which tools to use
    const useTools = enableTools && (allowedTools ? allowedTools.length > 0 : true);

    try {
      let totalTokens = 0;
      let allToolCalls: ToolCallResult[] = [];

      // Initialize message history
      const messages: any[] = [];

      // Build system message
      let systemMessage = '';

      // Add tool instructions if tools are available
      if (useTools) {
        const toolNames = allowedTools?.join(', ') || 'available tools';
        systemMessage = `You are an AI assistant with access to tools. You have the following tools available: ${toolNames}.

IMPORTANT: Use these tools proactively to accomplish your task. You don't need to ask the user for permission - just use the tools when needed.

- Use the 'read' tool to read files
- Use the 'write' tool to create or overwrite files
- Use the 'edit' tool to modify files with find/replace
- Use the 'bash' tool to execute shell commands (list files, search, etc.)

When the user asks you to analyze code, review files, or work with the file system, USE THE TOOLS IMMEDIATELY. Don't ask for code to be provided - read it yourself using the tools.

**CRITICAL**: After using tools, you MUST provide a text response summarizing what you did. Don't just call tools silently - explain your actions and results to the user.`;
      }

      // Add skill prompts (knowledge/guidance) if available
      if (skillPrompts && skillPrompts.length > 0) {
        if (systemMessage) {
          systemMessage += '\n\n';
        }
        systemMessage += '## Skills and Knowledge\n\n';
        systemMessage += 'You have access to the following specialized skills and knowledge:\n\n';
        systemMessage += skillPrompts.join('\n\n---\n\n');
      }

      // Add system message if we have content
      if (systemMessage) {
        messages.push({
          role: 'system',
          content: systemMessage
        });
      }

      // Add user message
      messages.push({
        role: 'user',
        content: fullPrompt,
      });

      // Multi-round tool calling loop (up to 50 rounds for complex tasks)
      // This allows the AI to continue using tools until the task is complete
      for (let round = 0; round < 50; round++) {
        // Build request body
        const requestBody: any = {
          model: modelId,
          messages: messages,
          temperature: 0.7,
          max_tokens: 4000,
        };

        // Add tools if enabled
        if (useTools) {
          // Only include allowed tools if specified
          if (allowedTools) {
            const filteredTools = this.toolRegistry.getAll().filter(tool =>
              allowedTools.includes(tool.name)
            );
            requestBody.tools = filteredTools.map(tool => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            }));
          } else {
            requestBody.tools = this.toolRegistry.toOpenRouterFormat();
          }
        }

        // Call OpenRouter API with retry logic
        const data = await this.callAPIWithRetry(requestBody);
        totalTokens += data.usage?.total_tokens || 0;

        const message = data.choices?.[0]?.message;

        // Check if model wants to call tools
        if (useTools && message?.tool_calls && message.tool_calls.length > 0) {
          // Add assistant's message with tool calls to history
          messages.push({
            role: 'assistant',
            content: message.content || '',
            tool_calls: message.tool_calls,
          });

          // Execute each tool call
          for (const toolCall of message.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);

            try {
              const result = await this.toolRegistry.execute(toolName, toolArgs);

              // Track tool call
              allToolCalls.push({
                name: toolName,
                arguments: toolArgs,
                result,
              });

              // Add tool result to message history
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(result),
              });
            } catch (error) {
              console.error(`Tool call failed: ${toolName}`, error);

              // Add error result to message history
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: String(error) }),
              });
            }
          }

          // Continue to next round - let AI respond based on tool results
          continue;
        } else {
          // AI gave final response without tool calls
          const finalOutput = message?.content || '';

          return {
            output: finalOutput,
            metadata: {
              model: modelId,
              duration: Date.now() - startTime,
              tokensUsed: totalTokens,
              toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            },
          };
        }
      }

      // If we've exceeded max rounds, return with warning
      const lastMessage = messages[messages.length - 1];
      const finalOutput = lastMessage.role === 'assistant'
        ? lastMessage.content
        : '[Tool calling exceeded maximum rounds]';

      return {
        output: finalOutput,
        metadata: {
          model: modelId,
          duration: Date.now() - startTime,
          tokensUsed: totalTokens,
          toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        },
      };
    } catch (error) {
      const classification = this.classifyError(error);

      // Only log errors if not in test mode
      if (process.env.NODE_ENV !== 'test' && !process.env.BUN_TEST) {
        console.error(`[OpenRouter] ${classification.type} error:`, classification.message);
      }

      // For specific error types, provide helpful information
      switch (classification.type) {
        case 'rate_limit':
          throw new Error(
            `Rate limit exceeded. Please wait a moment and try again. (${classification.message})`
          );

        case 'auth':
          throw new Error(
            `Authentication failed. Please check your OPENROUTER_API_KEY. (${classification.message})`
          );

        case 'model_unavailable':
          throw new Error(
            `Model not available. Try a different model. (${classification.message})`
          );

        case 'timeout':
          throw new Error(
            `Request timed out. This might be due to network issues or a very long response. (${classification.message})`
          );

        case 'network':
          throw new Error(
            `Network error. Please check your internet connection. (${classification.message})`
          );

        case 'tool_error':
          // Tool errors are already handled in the tool execution loop
          throw new Error(
            `Tool execution error: ${classification.message}`
          );

        default:
          throw new Error(
            `Failed to execute session: ${error instanceof Error ? error.message : String(error)}`
          );
      }
    }
  }

  /**
   * Build a prompt with context information
   */
  private buildPromptWithContext(spec: SessionSpec): string {
    let prompt = spec.prompt;

    // Add context if provided
    if (spec.context && spec.context.variables) {
      const contextVars = spec.context.variables;
      const contextKeys = Object.keys(contextVars);

      if (contextKeys.length > 0) {
        // Separate conversation history from regular variables
        const conversationKeys = contextKeys.filter(k => k.startsWith('conversation_turn_'));
        const regularKeys = contextKeys.filter(k => !k.startsWith('conversation_turn_'));

        // Add conversation history first (most important for multi-session workflows)
        if (conversationKeys.length > 0) {
          prompt += '\n\n## Previous Conversation History\n\n';
          // Sort by turn number
          conversationKeys.sort((a, b) => {
            const numA = parseInt(a.replace('conversation_turn_', ''), 10);
            const numB = parseInt(b.replace('conversation_turn_', ''), 10);
            return numA - numB;
          });

          for (const key of conversationKeys) {
            const turnNum = key.replace('conversation_turn_', '');
            const value = contextVars[key];
            prompt += `**Turn ${turnNum}:**\n${this.formatValue(value)}\n\n`;
          }
        }

        // Add regular variables if any
        if (regularKeys.length > 0) {
          prompt += '## Available Variables\n\n';

          for (const key of regularKeys) {
            const value = contextVars[key];
            prompt += `### ${key}\n`;

            if (typeof value === 'string') {
              prompt += `${value}\n\n`;
            } else if (Array.isArray(value)) {
              prompt += `${value.map((v, i) => `${i + 1}. ${this.formatValue(v)}`).join('\n')}\n\n`;
            } else if (isSessionResult(value)) {
              prompt += `${value.output}\n\n`;
            } else if (typeof value === 'object' && value !== null) {
              prompt += `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n`;
            } else {
              prompt += `${String(value)}\n\n`;
            }
          }
        }
      }
    }

    return prompt;
  }

  /**
   * Format a value for display in context
   */
  private formatValue(value: any): string {
    if (typeof value === 'string') {
      return value;
    } else if (isSessionResult(value)) {
      return value.output;
    } else if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    } else {
      return String(value);
    }
  }

  /**
   * Test the API connection
   */
  async test(): Promise<boolean> {
    try {
      const result = await this.executeSession(
        {
          agent: null,
          prompt: 'Say "Hello from OpenRouter!"',
          context: null,
        },
        {
          defaultModel: 'sonnet',
        } as RuntimeConfig
      );

      return result.output.includes('Hello') || result.output.length > 0;
    } catch (error) {
      console.error('OpenRouter test failed:', error);
      return false;
    }
  }
}

/**
 * Create an OpenRouter client from environment variables
 */
export function createOpenRouterClient(toolRegistry?: ToolRegistry): OpenRouterClient | null {
  // Try to load from environment
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.warn('OPENROUTER_API_KEY not found in environment');
    return null;
  }

  return new OpenRouterClient(apiKey, toolRegistry);
}
