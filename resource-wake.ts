// resource-wake.ts - config-driven resource subscriptions that wake the agent

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpServerManager } from "./server-manager.ts";
import type { ServerEntry } from "./types.ts";

const WAKE_TOKEN_PREFIX = "resource-wake";

export function resourceWakeToken(serverName: string, uri: string): string {
  return `${WAKE_TOKEN_PREFIX}:${serverName}:${uri}`;
}

/**
 * Register push listeners for every `subscribe` URI in the config.
 *
 * The server manager folds registered URIs into its subscriptions/listen
 * filter (re-establishing the stream when the filter changes), so the
 * server starts pushing ResourceUpdated notifications for them. Each
 * notification is delivered to the agent as a custom message that
 * triggers a turn. Level-triggered by design: the message names the URI,
 * the agent reads the resource only if it cares.
 *
 * Listeners live on the manager instance, so they are re-registered on
 * every initialization (config reload, session replacement) and die with
 * it on shutdown — no separate cleanup path.
 */
export function registerResourceWakeListeners(
  pi: ExtensionAPI,
  manager: McpServerManager,
  servers: Record<string, ServerEntry>,
): void {
  const sendMessage = typeof pi.sendMessage === "function"
    ? pi.sendMessage.bind(pi)
    : undefined;
  for (const [serverName, entry] of Object.entries(servers)) {
    if (!entry.subscribe || entry.subscribe.length === 0) continue;
    if (entry.protocolVersion === undefined || entry.protocolVersion === "legacy") {
      console.warn(
        `MCP server "${serverName}" sets subscribe but cannot receive push updates: protocolVersion must be "auto" or "2026-07-28" (subscriptions/listen needs the modern era). Set protocolVersion in the server entry.`,
      );
    }
    for (const uri of entry.subscribe) {
      manager.registerResourceUpdatedListener(
        resourceWakeToken(serverName, uri),
        serverName,
        uri,
        (updatedServer, updatedUri) => {
          if (!sendMessage) return;
          try {
            sendMessage(
              {
                customType: "mcp-resource-updated",
                content: `MCP resource updated: ${updatedUri} (server ${updatedServer}).`,
                display: true,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch (error) {
            console.error(`MCP: failed to deliver resource update for ${updatedUri}: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      );
    }
  }
}
