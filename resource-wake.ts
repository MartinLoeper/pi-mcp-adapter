// resource-wake.ts - config-driven resource subscriptions that wake the agent

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpServerManager } from "./server-manager.ts";
import type { ServerEntry } from "./types.ts";

type ResourceUpdatedListener = (serverName: string, uri: string) => void;

const WAKE_TOKEN_PREFIX = "resource-wake";
const DYNAMIC_TOKEN_PREFIX = "resource-wake:dynamic";

export function resourceWakeToken(serverName: string, uri: string): string {
  return `${WAKE_TOKEN_PREFIX}:${serverName}:${uri}`;
}

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

/** Dynamic subscriptions, keyed by manager so they die with the session state. */
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
 * Give every `subscribe` server the persistent connection its push
 * subscription requires. A lazy server connects on first tool use, so its
 * subscriptions would silently never flow; keep-alive connects at startup
 * and survives idle shutdowns. Explicit lifecycle settings are respected.
 */
export function normalizeSubscribeLifecycle(
  servers: Record<string, ServerEntry>,
): Record<string, ServerEntry> {
  let changed = false;
  const next: Record<string, ServerEntry> = { ...servers };
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry.subscribe || entry.subscribe.length === 0) continue;
    if (entry.lifecycle !== undefined) continue;
    next[name] = { ...entry, lifecycle: "keep-alive" };
    changed = true;
  }
  return changed ? next : servers;
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
  const wake = makeWakeListener(pi);
  for (const [serverName, entry] of Object.entries(servers)) {
    if (!entry.subscribe || entry.subscribe.length === 0) continue;
    if (entry.protocolVersion === undefined || entry.protocolVersion === "legacy") {
      console.warn(
        `MCP server "${serverName}" sets subscribe but cannot receive push updates: protocolVersion must be "auto" or "2026-07-28" (subscriptions/listen needs the modern era). Set protocolVersion in the server entry.`,
      );
    }
    if (entry.lifecycle === "lazy") {
      console.warn(
        `MCP server "${serverName}" sets subscribe with lifecycle "lazy": a lazy server connects on first tool use, so pushes cannot flow until then. Remove lifecycle or set "keep-alive".`,
      );
    }
    for (const uri of entry.subscribe) {
      manager.registerResourceUpdatedListener(
        resourceWakeToken(serverName, uri),
        serverName,
        uri,
        wake,
      );
    }
  }
}

/**
 * Subscribe at runtime to push updates for one resource URI. Idempotent;
 * re-subscribing an already-watched URI is a no-op. The manager folds the
 * URI into its listen filter immediately (re-establishing the stream when
 * connected). Dynamic subscriptions are lost when the session state is
 * recreated (reload); static config `subscribe` entries are re-registered.
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

/** Remove a runtime subscription. Static config `subscribe` entries are not affected. */
export function unsubscribeResource(
  manager: McpServerManager,
  serverName: string,
  uri: string,
): { ok: boolean; message: string; subscriptions: string[] } {
  const set = dynamicSubscriptions.get(manager);
  const key = `${serverName} ${uri}`;
  if (!set || !set.has(key)) {
    return { ok: false, message: `No dynamic subscription for ${uri} on ${serverName}. (Static config subscribe entries are not removable at runtime.)`, subscriptions: set ? [...set] : [] };
  }
  set.delete(key);
  manager.removeResourceUpdatedListener(dynamicWakeToken(serverName, uri));
  return { ok: true, message: `Unsubscribed from ${uri} on ${serverName}.`, subscriptions: [...set] };
}
