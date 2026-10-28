import { describe, expect, it, vi } from "vitest";
import { dynamicWakeToken, hasServerSubscriptions, MAX_SUBSCRIPTIONS_PER_SERVER, subscribeResource, unsubscribeResource } from "../resource-wake.ts";
import { MAX_RESOURCE_SUBSCRIPTIONS } from "../server-manager.ts";

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

function makePi(withSendMessage = true) {
  return {
    sendMessage: withSendMessage
      ? vi.fn()
      : undefined,
  } as unknown as Parameters<typeof subscribeResource>[0];
}

describe("subscribeResource / unsubscribeResource", () => {
  it("subscribes, tracks, and wakes the agent on updates", () => {
    const manager = makeManager();
    const pi = makePi();
    const result = subscribeResource(pi, manager as never, "my-server", "notes://all");
    expect(result.ok).toBe(true);
    expect(result.subscriptions).toEqual(["my-server notes://all"]);

    const registration = manager.registrations.get(dynamicWakeToken("my-server", "notes://all"))!;
    registration.listener("my-server", "notes://all");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "mcp-resource-updated",
        content: "MCP resource updated: notes://all (server my-server).",
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("re-subscribing is idempotent (no duplicate wake)", () => {
    const manager = makeManager();
    const pi = makePi();
    subscribeResource(pi, manager as never, "my-server", "notes://all");
    const again = subscribeResource(pi, manager as never, "my-server", "notes://all");
    expect(again.ok).toBe(true);
    expect(again.message).toContain("Already subscribed");
    expect(manager.registrations.size).toBe(1);
  });

  it("unsubscribes exactly the named registration", () => {
    const manager = makeManager();
    const pi = makePi();
    subscribeResource(pi, manager as never, "my-server", "notes://all");
    subscribeResource(pi, manager as never, "my-server", "notes://items/1");
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
    const pi = makePi();
    subscribeResource(pi, managerA as never, "my-server", "notes://all");
    const onB = subscribeResource(pi, managerB as never, "my-server", "notes://all");
    expect(onB.message).not.toContain("Already subscribed");
    expect(managerA.registrations.size).toBe(1);
    expect(managerB.registrations.size).toBe(1);
  });

  it("survives hosts without pi.sendMessage (no crash, no message)", () => {
    const manager = makeManager();
    const pi = makePi(false);
    subscribeResource(pi, manager as never, "my-server", "notes://all");
    const registration = manager.registrations.get(dynamicWakeToken("my-server", "notes://all"))!;
    expect(() => registration.listener("my-server", "notes://all")).not.toThrow();
    expect(pi.sendMessage).toBeUndefined();
  });

  it("fails loudly at the listen-filter limit instead of silently dropping the oldest URI", () => {
    const manager = makeManager();
    const pi = makePi();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_SERVER; i++) {
      const result = subscribeResource(pi, manager as never, "my-server", `notes://items/${i}`);
      expect(result.ok).toBe(true);
    }
    const over = subscribeResource(pi, manager as never, "my-server", "notes://one-too-many");
    expect(over.ok).toBe(false);
    expect(over.message).toContain("listen filter drops the oldest");
    // The over-limit URI was never registered and is not listed.
    expect(over.subscriptions).not.toContain("my-server notes://one-too-many");
    // The limit is per server: another server can still subscribe.
    const other = subscribeResource(pi, manager as never, "other-server", "notes://all");
    expect(other.ok).toBe(true);
  });

  it("gives distinct server/URI pairs distinct tokens even with separator characters", () => {
    expect(dynamicWakeToken("a:notes", "file:///x")).not.toBe(dynamicWakeToken("a", "notes:file:///x"));
    expect(dynamicWakeToken("a:notes", "file:///x")).not.toBe(dynamicWakeToken("a:notes", "file:///y"));
  });

  it("reports per-server subscription presence for keep-alive release", () => {
    const manager = makeManager();
    const pi = makePi();
    expect(hasServerSubscriptions(manager as never, "my-server")).toBe(false);
    subscribeResource(pi, manager as never, "my-server", "notes://all");
    expect(hasServerSubscriptions(manager as never, "my-server")).toBe(true);
    unsubscribeResource(manager as never, "my-server", "notes://all");
    expect(hasServerSubscriptions(manager as never, "my-server")).toBe(false);
    // Another server's subscription must not keep the flag alive.
    subscribeResource(pi, manager as never, "other-server", "notes://all");
    expect(hasServerSubscriptions(manager as never, "my-server")).toBe(false);
  });
});
