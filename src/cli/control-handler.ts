/**
 * Control Handler — routes control_request messages from the CLI
 * to the appropriate handler (permission, hook, MCP, elicitation).
 */

import type { CliControlRequest } from "../types/cli-protocol";
import type { CliProcess } from "./process-manager";
import { sendControlResponse } from "./process-manager";
import { logDebug, logError } from "../utils/logger";

export type PermissionRequestHandler = (
  requestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  suggestions: unknown[],
  description?: string
) => Promise<{ accepted: boolean; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown }>;

export type HookCallbackHandler = (
  requestId: string,
  hookEventName: string,
  hookData: unknown
) => Promise<unknown>;

export type McpMessageHandler = (
  requestId: string,
  serverName: string,
  message: unknown
) => Promise<unknown>;

export type ElicitationHandler = (
  requestId: string,
  elicitation: unknown
) => Promise<unknown>;

export interface ControlHandlerConfig {
  onPermissionRequest: PermissionRequestHandler;
  onHookCallback?: HookCallbackHandler;
  onMcpMessage?: McpMessageHandler;
  onElicitation?: ElicitationHandler;
}

/**
 * Process a control_request from the CLI and send back a control_response.
 */
export async function handleControlRequest(
  cliProcess: CliProcess,
  request: CliControlRequest,
  config: ControlHandlerConfig
): Promise<void> {
  const { request_id } = request;

  try {
    // Determine request subtype by checking which fields are present
    if (request.tool_name !== undefined) {
      // Permission request (can_use_tool)
      logDebug(`Permission request: ${request.tool_name} (${request_id})`);
      const result = await config.onPermissionRequest(
        request_id,
        request.tool_name,
        request.tool_input ?? {},
        request.suggestions ?? [],
        request.description
      );

      if (result.accepted) {
        sendControlResponse(cliProcess, request_id, {
          behavior: "allow",
          updatedInput: result.updatedInput,
          updatedPermissions: result.updatedPermissions,
        });
      } else {
        sendControlResponse(cliProcess, request_id, {
          behavior: "deny",
          message:
            "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed.",
        });
      }
    } else if (request.hook_event_name !== undefined) {
      // Hook callback
      logDebug(`Hook callback: ${request.hook_event_name} (${request_id})`);
      if (config.onHookCallback) {
        const result = await config.onHookCallback(
          request_id,
          request.hook_event_name,
          request.hook_data
        );
        sendControlResponse(cliProcess, request_id, result);
      } else {
        // No hook handler, just succeed
        sendControlResponse(cliProcess, request_id, {});
      }
    } else if (request.mcp_server_name !== undefined) {
      // MCP message relay
      logDebug(`MCP message: ${request.mcp_server_name} (${request_id})`);
      if (config.onMcpMessage) {
        const result = await config.onMcpMessage(
          request_id,
          request.mcp_server_name,
          request.mcp_message
        );
        sendControlResponse(cliProcess, request_id, result);
      } else {
        sendControlResponse(cliProcess, request_id, {});
      }
    } else if (request.elicitation !== undefined) {
      // Elicitation request
      logDebug(`Elicitation request (${request_id})`);
      if (config.onElicitation) {
        const result = await config.onElicitation(
          request_id,
          request.elicitation
        );
        sendControlResponse(cliProcess, request_id, result);
      } else {
        sendControlResponse(cliProcess, request_id, { action: "cancel" });
      }
    } else {
      logDebug(
        `Unknown control request type (${request_id}): ${JSON.stringify(request).slice(0, 200)}`
      );
      sendControlResponse(
        cliProcess,
        request_id,
        "Unknown control request type",
        true
      );
    }
  } catch (err) {
    logError(`Control request handler error (${request_id})`, err);
    sendControlResponse(
      cliProcess,
      request_id,
      err instanceof Error ? err.message : "Internal error",
      true
    );
  }
}
