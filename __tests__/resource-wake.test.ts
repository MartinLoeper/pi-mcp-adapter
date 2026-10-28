import { describe, expect, it, vi } from "vitest";
import { registerResourceWakeListeners, resourceWakeToken } from "../resource-wake.ts";
import type { ServerEntry } from "../types.ts";

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
      ? vi.fn().mockResolvedValue(undefined)
      : undefined,
  } as unknown as Parameters<typeof registerResourceWakeListeners>[0];
}

describe("registerResourceWakeListeners", () => {
  it("registers a listener for every subscribe URI of every configured server", () => {
    const manager = makeManager();
    const servers: Record<string, ServerEntry> = {
      "magellan-ci": { url: "http://localhost:9097/mcp", subscribe: ["magellan://pipelineruns", "magellan://analyses"] },
      "proxmox": { command: "uvx", args: ["proxmox-mcp-plus"] },
    };
    registerResourceWakeListeners(makePi(), manager as never, servers);

    expect([...manager.registrations.keys()].sort()).toEqual([
      resourceWakeToken("magellan-ci", "magellan://analyses"),
      resourceWakeToken("magellan-ci", "magellan://pipelineruns"),
    ]);
    // No registration for servers without a subscribe list.
    expect([...manager.registrations.values()].every(r => r.serverName === "magellan-ci")).toBe(true);
  });

  it("wakes the agent with a turn-triggering message naming the URI", () => {
    const manager = makeManager();
    const pi = makePi();
    registerResourceWakeListeners(pi, manager as never, {
      "magellan-ci": { url: "http://x", subscribe: ["magellan://pipelineruns"] },
    });

    const registration = manager.registrations.get(resourceWakeToken("magellan-ci", "magellan://pipelineruns"))!;
    registration.listener("magellan-ci", "magellan://pipelineruns");

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      {
        customType: "mcp-resource-updated",
        content: "MCP resource updated: magellan://pipelineruns (server magellan-ci).",
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("ignores empty subscribe lists", () => {
    const manager = makeManager();
    registerResourceWakeListeners(makePi(), manager as never, {
      "a": { url: "http://x", subscribe: [] },
      "b": { url: "http://y" },
    });
    expect(manager.registrations.size).toBe(0);
  });

  it("warns when subscribe cannot receive pushes (legacy or unset protocolVersion)", () => {
    const manager = makeManager();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      registerResourceWakeListeners(makePi(), manager as never, {
        "legacy-era": { url: "http://x", subscribe: ["magellan://pipelineruns"] },
        "auto-era": { url: "http://y", protocolVersion: "auto", subscribe: ["magellan://pipelineruns"] },
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('"legacy-era"');
      // The listener is still registered — if the connection does negotiate
      // the modern era by other means, pushes flow; the warning is advisory.
      expect(manager.registrations.size).toBe(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("survives hosts without pi.sendMessage (no crash, no message)", () => {
    const manager = makeManager();
    const pi = makePi(false);
    registerResourceWakeListeners(pi, manager as never, {
      "magellan-ci": { url: "http://x", subscribe: ["magellan://pipelineruns"] },
    });

    const registration = manager.registrations.get(resourceWakeToken("magellan-ci", "magellan://pipelineruns"))!;
    expect(() => registration.listener("magellan-ci", "magellan://pipelineruns")).not.toThrow();
    expect(pi.sendMessage).toBeUndefined();
  });

  it("logs instead of throwing when message delivery fails", () => {
    const manager = makeManager();
    const pi = makePi();
    (pi.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("session gone");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      registerResourceWakeListeners(pi, manager as never, {
        "magellan-ci": { url: "http://x", subscribe: ["magellan://pipelineruns"] },
      });
      const registration = manager.registrations.get(resourceWakeToken("magellan-ci", "magellan://pipelineruns"))!;
      expect(() => registration.listener("magellan-ci", "magellan://pipelineruns")).not.toThrow();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
