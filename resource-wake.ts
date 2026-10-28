// resource-wake.ts - runtime resource subscriptions that wake the agent

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpServerManager } from "./server-manager.ts";

type ResourceUpdatedListener = (serverName: string, uri: string) => void;

const DYNAMIC_TOKEN_PREFIX = "resource-wake:dynamic";

export function dynamicWakeToken(serverName: string, uri: string): string {
  return `${DYNAMIC_TOKEN_PREFIX}:${serverName}:${uri}`;
}

function makeWakeListener(pi: ExtensionAPI): ResourceUpdatedListener {
  const sendMessage = typeof pi.sendMessage === "function"
    ? pi.sendMessage.bind(pi)
    : undefined;
  return (updatedServer, updatedUri) => {
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
  };
}

/** Runtime subscriptions, keyed by manager so they die with the session state. */
const dynamicSubscriptions = new WeakMap<McpServerManager, Set<string>>();

function dynamicSet(manager: McpServerManager): Set<string> {
  let set = dynamicSubscriptions.get(manager);
  if (!set) {
    set = new Set();
    dynamicSubscriptions.set(manager, set);
  }
  return set;
}

/**
 * Subscribe at runtime to push updates for one resource URI. Idempotent;
 * re-subscribing an already-watched URI is a no-op. The server manager folds
 * the URI into its subscriptions/listen filter immediately (re-establishing
 * the stream when connected). Each ResourceUpdated notification for the URI
 * is delivered to the agent as a custom message that triggers a turn —
 * level-triggered by design: the message names the URI, the agent reads the
 * resource only if it cares.
 *
 * Subscriptions are per session state: they die when it is recreated
 * (reload), and nothing subscribes unless the agent asks.
 */
export function subscribeResource(
  pi: ExtensionAPI,
  manager: McpServerManager,
  serverName: string,
  uri: string,
): { ok: boolean; message: string; subscriptions: string[] } {
  const set = dynamicSet(manager);
  const key = `${serverName} ${uri}`;
  if (set.has(key)) {
    return { ok: true, message: `Already subscribed to ${uri} on ${serverName}.`, subscriptions: [...set] };
  }
  set.add(key);
  manager.registerResourceUpdatedListener(
    dynamicWakeToken(serverName, uri),
    serverName,
    uri,
    makeWakeListener(pi),
  );
  return { ok: true, message: `Subscribed to ${uri} on ${serverName}. Updates arrive as agent turns.`, subscriptions: [...set] };
}

/** Remove a runtime subscription; unknown URIs report failure. */
export function unsubscribeResource(
  manager: McpServerManager,
  serverName: string,
  uri: string,
): { ok: boolean; message: string; subscriptions: string[] } {
  const set = dynamicSubscriptions.get(manager);
  const key = `${serverName} ${uri}`;
  if (!set || !set.has(key)) {
    return { ok: false, message: `No subscription for ${uri} on ${serverName}.`, subscriptions: set ? [...set] : [] };
  }
  set.delete(key);
  manager.removeResourceUpdatedListener(dynamicWakeToken(serverName, uri));
  return { ok: true, message: `Unsubscribed from ${uri} on ${serverName}.`, subscriptions: [...set] };
}
