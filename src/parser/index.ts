/**
 * whipflow Parser Module
 *
 * Exports all parser-related functionality including:
 * - Lexer/Tokenizer
 * - Token types
 * - AST node types
 * - Parser
 */

// Token types and utilities (types)
export type {
  TokenType,
  Token,
  SourceLocation,
  SourceSpan,
  StringTokenMetadata,
  EscapeSequenceInfo,
  InterpolationInfo,
} from './tokens';

// Token utilities (values)
export {
  KEYWORDS,
  isKeyword,
  isTrivia,
} from './tokens';

// Lexer types
export type {
  LexerOptions,
  LexerResult,
  LexerError,
} from './lexer';

// Lexer class and functions
export {
  Lexer,
  tokenize,
  tokenizeWithoutComments,
  extractComments,
} from './lexer';

// AST types
export type {
  ASTNode,
  ProgramNode,
  StatementNode,
  ExpressionNode,
  CommentNode,
  CommentStatementNode,
  EscapeSequence,
  StringLiteralNode,
  NumberLiteralNode,
  IdentifierNode,
  DiscretionNode,
  SessionStatementNode,
  PropertyNode,
  ImportStatementNode,
  AgentDefinitionNode,
  BlockDefinitionNode,
  DoBlockNode,
  ParallelBlockNode,
  LoopBlockNode,
  RepeatBlockNode,
  ForEachBlockNode,
  TryBlockNode,
  ThrowStatementNode,
  ReturnStatementNode,
  InterpolatedStringNode,
  ChoiceBlockNode,
  ChoiceOptionNode,
  IfStatementNode,
  ElseIfClauseNode,
  LetBindingNode,
  ConstBindingNode,
  AssignmentNode,
  ArrayExpressionNode,
  ObjectExpressionNode,
  PipeExpressionNode,
  PipeOperationNode,
  ArrowExpressionNode,
  AskStatementNode,
  RunStatementNode,
  SkillInvocationNode,
  SkillParamNode,
  ASTVisitor,
} from './ast';

// AST functions
export {
  createCommentNode,
  createProgramNode,
  walkAST,
  isStringLiteral,
} from './ast';

// AST utilities
export {
  isInterpolatedString,
  getStringValue,
  getRawString,
  isTripleQuoted,
} from './ast-utils';

// Parser types
export type {
  ParseResult,
  ParseError,
} from './parser';

// Parser class and functions
export {
  Parser,
  parse,
  parseComments,
} from './parser';
