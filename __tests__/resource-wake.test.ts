import { describe, expect, it, vi } from "vitest";
import { dynamicWakeToken, hasServerSubscriptions, MAX_SUBSCRIPTIONS_PER_SERVER, MCP_RESOURCE_UPDATED_TYPE, subscribeResource, unsubscribeResource } from "../resource-wake.ts";
import { MAX_RESOURCE_SUBSCRIPTIONS } from "../server-manager.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import type { McpServerManager } from "../server-manager.ts";
import type { SendMessageFn } from "../state.ts";
import type { ServerDefinition } from "../types.ts";

function makeSendMessage() {
  return vi.fn() as unknown as SendMessageFn & ReturnType<typeof vi.fn>;
}

function makeLifecycleManager() {
  // The lifecycle manager only needs the manager for connect/close paths we
  // do not exercise here; keep-alive bookkeeping is self-contained.
  return new McpLifecycleManager({} as unknown as McpServerManager);
}

const definition = { url: "http://x" } as ServerDefinition;

describe("keep-alive hold ownership", () => {
  it("a subscription-owned hold is removed when the subscription releases it", () => {
    const lifecycle = makeLifecycleManager();
    lifecycle.markKeepAlive("server", definition, "resource-subscription");
    lifecycle.releaseKeepAlive("server", "resource-subscription");
    // No other owner: the hold (and its reconnect retries) is gone.
    expect(lifecycle.isKeepAlive("server")).toBeFalsy();
  });

  it("a config-owned hold survives a subscription release on the same server", () => {
    const lifecycle = makeLifecycleManager();
    lifecycle.markKeepAlive("server", definition, "config");
    lifecycle.markKeepAlive("server", definition, "resource-subscription");
    lifecycle.releaseKeepAlive("server", "resource-subscription");
    expect(lifecycle.isKeepAlive("server")).toBe(true);
  });

  it("a hold established by a later connect survives the subscription release", () => {
    // lazy-keep-alive servers are marked "config" after a successful connect.
    const lifecycle = makeLifecycleManager();
    lifecycle.markKeepAlive("server", definition, "resource-subscription");
    lifecycle.markKeepAlive("server", definition, "config"); // connect succeeded
    lifecycle.releaseKeepAlive("server", "resource-subscription");
    expect(lifecycle.isKeepAlive("server")).toBe(true);
  });

  it("releasing an owner that never marked is a no-op", () => {
    const lifecycle = makeLifecycleManager();
    lifecycle.markKeepAlive("server", definition, "config");
    expect(() => lifecycle.releaseKeepAlive("server", "resource-subscription")).not.toThrow();
    expect(lifecycle.isKeepAlive("server")).toBe(true);
  });

  it("unregistering a server drops all owners", () => {
    const lifecycle = makeLifecycleManager();
    lifecycle.markKeepAlive("server", definition, "config");
    lifecycle.markKeepAlive("server", definition, "resource-subscription");
    lifecycle.unregisterServer("server");
    expect(lifecycle.isKeepAlive("server")).toBeFalsy();
  });
});

describe("module constants", () => {
  it("keeps the local per-server cap in sync with the listen-filter cap", () => {
    expect(MAX_SUBSCRIPTIONS_PER_SERVER).toBe(MAX_RESOURCE_SUBSCRIPTIONS);
  });
});

type Listener = (serverName: string, uri: string) => void;

function makeManager() {
  const registrations = new Map<string, { serverName: string; uri: string; listener: Listener }>();
  return {
    registrations,
    registerResourceUpdatedListener(token: string, serverName: string, uri: string, listener: Listener) {
      registrations.set(token, { serverName, uri, listener });
    },
    removeResourceUpdatedListener(token: string) {
      registrations.delete(token);
    },
  };
}

describe("subscribeResource / unsubscribeResource", () => {
  it("subscribes, tracks, and wakes the agent on updates through the sendMessage seam", () => {
    const manager = makeManager();
    const sendMessage = makeSendMessage();
    const result = subscribeResource(sendMessage, manager as never, "my-server", "notes://all");
    expect(result.ok).toBe(true);
    expect(result.subscriptions).toEqual(["my-server notes://all"]);

    const registration = manager.registrations.get(dynamicWakeToken("my-server", "notes://all"))!;
    registration.listener("my-server", "notes://all");
    // Same structure as background task results: content blocks, structured
    // details, follow-up delivery that triggers a turn.
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: MCP_RESOURCE_UPDATED_TYPE,
        display: true,
        content: [{ type: "text", text: "MCP resource updated: notes://all (server my-server)." }],
        details: { subscription: { server: "my-server", uri: "notes://all" } },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("re-subscribing is idempotent (no duplicate wake)", () => {
    const manager = makeManager();
    const sendMessage = makeSendMessage();
    subscribeResource(sendMessage, manager as never, "my-server", "notes://all");
    const again = subscribeResource(sendMessage, manager as never, "my-server", "notes://all");
    expect(again.ok).toBe(true);
    expect(again.message).toContain("Already subscribed");
    expect(manager.registrations.size).toBe(1);
  });

  it("unsubscribes exactly the named registration", () => {
    const manager = makeManager();
    const sendMessage = makeSendMessage();
    subscribeResource(sendMessage, manager as never, "my-server", "notes://all");
    subscribeResource(sendMessage, manager as never, "my-server", "notes://items/1");
    expect(manager.registrations.size).toBe(2);

    const result = unsubscribeResource(manager as never, "my-server", "notes://all");
    expect(result.ok).toBe(true);
    expect(manager.registrations.has(dynamicWakeToken("my-server", "notes://all"))).toBe(false);
    expect(manager.registrations.has(dynamicWakeToken("my-server", "notes://items/1"))).toBe(true);
    expect(result.subscriptions).toEqual(["my-server notes://items/1"]);
  });

  it("unsubscribing an unknown URI reports failure without touching others", () => {
    const manager = makeManager();
    const result = unsubscribeResource(manager as never, "my-server", "never://subscribed");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No subscription");
  });

  it("subscriptions are tracked per manager instance (session state)", () => {
    const managerA = makeManager();
    const managerB = makeManager();
    const sendMessage = makeSendMessage();
    subscribeResource(sendMessage, managerA as never, "my-server", "notes://all");
    const onB = subscribeResource(sendMessage, managerB as never, "my-server", "notes://all");
    expect(onB.message).not.toContain("Already subscribed");
    expect(managerA.registrations.size).toBe(1);
    expect(managerB.registrations.size).toBe(1);
  });

  it("fails loudly at the listen-filter limit instead of silently dropping the oldest URI", () => {
    const manager = makeManager();
    const sendMessage = makeSendMessage();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_SERVER; i++) {
      const result = subscribeResource(sendMessage, manager as never, "my-server", `notes://items/${i}`);
      expect(result.ok).toBe(true);
    }
    const over = subscribeResource(sendMessage, manager as never, "my-server", "notes://one-too-many");
    expect(over.ok).toBe(false);
    expect(over.message).toContain("listen filter drops the oldest");
    // The over-limit URI was never registered and is not listed.
    expect(over.subscriptions).not.toContain("my-server notes://one-too-many");
    // The limit is per server: another server can still subscribe.
    const other = subscribeResource(sendMessage, manager as never, "other-server", "notes://all");
    expect(other.ok).toBe(true);
  });

  it("gives distinct server/URI pairs distinct tokens even with separator characters", () => {
    expect(dynamicWakeToken("a:notes", "file:///x")).not.toBe(dynamicWakeToken("a", "notes:file:///x"));
    expect(dynamicWakeToken("a:notes", "file:///x")).not.toBe(dynamicWakeToken("a:notes", "file:///y"));
  });

  it("reports per-server subscription presence for keep-alive release", () => {
    const manager = makeManager();
    const sendMessage = makeSendMessage();
    expect(hasServerSubscriptions(manager as never, "my-server")).toBe(false);
    subscribeResource(sendMessage, manager as never, "my-server", "notes://all");
    expect(hasServerSubscriptions(manager as never, "my-server")).toBe(true);
    unsubscribeResource(manager as never, "my-server", "notes://all");
    expect(hasServerSubscriptions(manager as never, "my-server")).toBe(false);
    // Another server's subscription must not keep the flag alive.
    subscribeResource(sendMessage, manager as never, "other-server", "notes://all");
    expect(hasServerSubscriptions(manager as never, "my-server")).toBe(false);
  });
});
