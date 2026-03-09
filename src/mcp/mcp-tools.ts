/**
 * MCP Tool implementations — IDE tools callable by claude.exe.
 *
 * In standalone browser mode, most tools return stubs since there's
 * no IDE editor. In VSCode mode, a subclass could override these
 * with real VSCode API implementations.
 *
 * NOTE: This module has NO vscode dependency.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolHandler {
  listTools(): McpToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "openFile",
    description: "Open a file in the editor",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute file path" },
        line: { type: "number", description: "Line number to jump to" },
        column: { type: "number", description: "Column number" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "openDiff",
    description: "Open a diff view for a file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Original file path",
        },
        newContent: {
          type: "string",
          description: "New file content",
        },
        tabLabel: { type: "string", description: "Tab label" },
      },
      required: ["filePath", "newContent"],
    },
  },
  {
    name: "getDiagnostics",
    description: "Get LSP diagnostics for workspace files",
    inputSchema: {
      type: "object",
      properties: {
        uris: {
          type: "array",
          items: { type: "string" },
          description: "File URIs to get diagnostics for",
        },
      },
    },
  },
  {
    name: "getOpenEditors",
    description: "Get list of currently open editor tabs",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "getWorkspaceFolders",
    description: "Get workspace folder paths",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "getCurrentSelection",
    description: "Get the currently selected text in the active editor",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "close_tab",
    description: "Close a specific editor tab",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "closeAllDiffTabs",
    description: "Close all diff viewer tabs",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "checkDocumentDirty",
    description: "Check if a file has unsaved changes",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "saveDocument",
    description: "Save a file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "isSupportedBrowser",
    description: "Check if the current IDE browser is supported",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * Create a tool handler with standalone (non-IDE) implementations.
 * These are functional stubs — claude.exe can call them but they
 * won't open actual IDE editors.
 */
export function createToolHandler(options: {
  workspaceFolders: string[];
}): McpToolHandler {
  return {
    listTools(): McpToolDefinition[] {
      return TOOL_DEFINITIONS;
    },

    async callTool(
      name: string,
      args: Record<string, unknown>
    ): Promise<unknown> {
      switch (name) {
        case "openFile":
          console.log(`[MCP Tool] openFile: ${args.filePath}`);
          return { success: true };

        case "openDiff":
          console.log(
            `[MCP Tool] openDiff: ${args.filePath} (${String(args.newContent ?? "").length} chars)`
          );
          return { success: true };

        case "getDiagnostics":
          // No LSP in standalone mode
          return { diagnostics: [] };

        case "getOpenEditors":
          return { editors: [] };

        case "getWorkspaceFolders":
          return {
            folders: options.workspaceFolders.map((f) => ({
              name: f.split(/[\\/]/).pop() || f,
              path: f,
            })),
          };

        case "getCurrentSelection":
          return null;

        case "close_tab":
          return { success: true };

        case "closeAllDiffTabs":
          return { success: true };

        case "checkDocumentDirty":
          return { isDirty: false };

        case "saveDocument":
          return { success: true };

        case "isSupportedBrowser":
          return { supported: true };

        default:
          console.log(`[MCP Tool] Unknown tool: ${name}`);
          return { error: `Unknown tool: ${name}` };
      }
    },
  };
}
