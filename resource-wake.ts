// resource-wake.ts - runtime resource subscriptions that wake the agent

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpServerManager } from "./server-manager.ts";

type ResourceUpdatedListener = (serverName: string, uri: string) => void;

const DYNAMIC_TOKEN_PREFIX = "resource-wake:dynamic";

/** Owner tag for the keep-alive holds a resource subscription adds. */
export const SUBSCRIPTION_KEEP_ALIVE_OWNER = "resource-subscription";

/**
 * Mirrors MAX_RESOURCE_SUBSCRIPTIONS in server-manager.ts (the listen-filter
 * cap per server). Declared locally — not imported — so this module adds no
 * runtime dependency on server-manager.ts; a test asserts the two stay in
 * sync.
 */
export const MAX_SUBSCRIPTIONS_PER_SERVER = 32;

export function dynamicWakeToken(serverName: string, uri: string): string {
  // JSON encoding: server names and URIs can both contain separators, so a
  // plain join could collide distinct pairs.
  return `${DYNAMIC_TOKEN_PREFIX}:${JSON.stringify([serverName, uri])}`;
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

/**
 * Runtime subscriptions, keyed by manager (session state) and then by server,
 * so they die with the session state and per-server counts are exact.
 */
const dynamicSubscriptions = new WeakMap<McpServerManager, Map<string, Set<string>>>();

function serverSet(manager: McpServerManager, serverName: string): Set<string> {
  let servers = dynamicSubscriptions.get(manager);
  if (!servers) {
    servers = new Map();
    dynamicSubscriptions.set(manager, servers);
  }
  let uris = servers.get(serverName);
  if (!uris) {
    uris = new Set();
    servers.set(serverName, uris);
  }
  return uris;
}

function flatten(servers: Map<string, Set<string>> | undefined): string[] {
  if (!servers) return [];
  const entries: string[] = [];
  for (const [serverName, uris] of servers) {
    for (const uri of uris) entries.push(`${serverName} ${uri}`);
  }
  return entries;
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
 * The per-server count is capped at the manager's listen-filter limit
 * (MAX_RESOURCE_SUBSCRIPTIONS): beyond it the filter silently drops the
 * oldest URI, so subscribing further would report success while never
 * delivering. The cap fails loudly instead.
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
  const uris = serverSet(manager, serverName);
  if (uris.has(uri)) {
    return { ok: true, message: `Already subscribed to ${uri} on ${serverName}.`, subscriptions: flatten(dynamicSubscriptions.get(manager)) };
  }
  if (uris.size >= MAX_SUBSCRIPTIONS_PER_SERVER) {
    return {
      ok: false,
      message: `Cannot subscribe to ${uri} on ${serverName}: this server already watches ${uris.size} resources and the listen filter drops the oldest beyond ${MAX_SUBSCRIPTIONS_PER_SERVER}. Unsubscribe one first.`,
      subscriptions: flatten(dynamicSubscriptions.get(manager)),
    };
  }
  uris.add(uri);
  manager.registerResourceUpdatedListener(
    dynamicWakeToken(serverName, uri),
    serverName,
    uri,
    makeWakeListener(pi),
  );
  return { ok: true, message: `Subscribed to ${uri} on ${serverName}. Updates arrive as agent turns.`, subscriptions: flatten(dynamicSubscriptions.get(manager)) };
}

/** Remove a runtime subscription; unknown URIs report failure. */
export function unsubscribeResource(
  manager: McpServerManager,
  serverName: string,
  uri: string,
): { ok: boolean; message: string; subscriptions: string[] } {
  const servers = dynamicSubscriptions.get(manager);
  const uris = servers?.get(serverName);
  if (!servers || !uris || !uris.has(uri)) {
    return { ok: false, message: `No subscription for ${uri} on ${serverName}.`, subscriptions: flatten(servers) };
  }
  uris.delete(uri);
  if (uris.size === 0) servers.delete(serverName);
  manager.removeResourceUpdatedListener(dynamicWakeToken(serverName, uri));
  return { ok: true, message: `Unsubscribed from ${uri} on ${serverName}.`, subscriptions: flatten(servers) };
}

/** Whether the session holds runtime subscriptions for a server. */
export function hasServerSubscriptions(manager: McpServerManager, serverName: string): boolean {
  const uris = dynamicSubscriptions.get(manager)?.get(serverName);
  return uris !== undefined && uris.size > 0;
}
