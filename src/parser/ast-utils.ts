/**
 * AST Utility Functions
 * Helper functions for working with AST nodes
 */

import { StringLiteralNode, InterpolatedStringNode, ASTNode } from './ast';

/**
 * Type guard to check if a node is a StringLiteralNode
 */
export function isStringLiteral(node: ASTNode): node is StringLiteralNode {
  return node.type === 'StringLiteral';
}

/**
 * Type guard to check if a node is an InterpolatedStringNode
 */
export function isInterpolatedString(node: ASTNode): node is InterpolatedStringNode {
  return node.type === 'InterpolatedString';
}

/**
 * Safely get the value from a StringLiteralNode or InterpolatedStringNode
 * For InterpolatedString, returns the raw string representation
 */
export function getStringValue(node: StringLiteralNode | InterpolatedStringNode): string {
  if (isStringLiteral(node)) {
    return node.value;
  } else {
    // For interpolated strings, return the raw representation
    return node.raw;
  }
}

/**
 * Get the raw string value from either string node type
 */
export function getRawString(node: StringLiteralNode | InterpolatedStringNode): string {
  return node.raw;
}

/**
 * Check if a string node is triple-quoted
 */
export function isTripleQuoted(node: StringLiteralNode | InterpolatedStringNode): boolean {
  return node.isTripleQuoted;
}
