/**
 * MCP tool-result helpers.
 *
 * Every tool returns the same `{ content: [...] }` shape. These wrappers keep
 * call sites terse and guarantee consistent error surfacing: failures come
 * back as `isError: true` text so the LLM can react instead of the transport
 * throwing.
 *
 * Part of Docker MCP Server.
 * Crafted by SoyRage Agency — https://soyrage.es/
 * Licensed under the MIT License.
 */

/**
 * The subset of the MCP tool-result shape this server produces.
 *
 * The index signature keeps us structurally compatible with the SDK's
 * `CallToolResult` type (which allows arbitrary extra fields via `_meta`).
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Build a successful text result. */
export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Build an error text result the LLM can read and recover from. */
export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Wrap an async tool handler so any thrown error becomes a clean `fail(...)`
 * result. This keeps individual handlers focused on the happy path.
 */
export function guard(
  handler: () => Promise<ToolResult>,
): Promise<ToolResult> {
  return handler().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    return fail(message);
  });
}
