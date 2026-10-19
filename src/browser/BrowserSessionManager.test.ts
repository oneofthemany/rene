import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserSessionManager,
  type BrowserSessionLauncher,
} from "./BrowserSessionManager.js";

/** A DevTools endpoint that lists one page, as Chrome's /json/list does. */
const devtools = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer((request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          id: "PAGE1",
          type: "page",
          url: "http://127.0.0.1:9/app",
          title: "App",
        },
        { type: "page" },
      ]),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("no port");
  return { server, port: address.port };
};

/** Stands in for Playwright: publishes the port like Chrome and records calls. */
const fakeLauncher = (port: number, options: { closeFails?: boolean } = {}) => {
  const calls = { profile: "", goto: [] as string[], closed: 0 };
  let onClose: (() => void) | undefined;
  const context = {
    pages: () => [
      {
        goto: async (url: string) => {
          calls.goto.push(url);
          return null;
        },
      },
    ],
    newPage: async () => {
      throw new Error("not used");
    },
    close: async () => {
      calls.closed += 1;
      if (options.closeFails) throw new Error("browser would not close");
      onClose?.();
    },
    on: (event: string, listener: () => void) => {
      if (event === "close") onClose = listener;
      return context;
    },
  };
  const launcher: BrowserSessionLauncher = {
    launchPersistentContext: async (profile) => {
      calls.profile = profile;
      await writeFile(
        join(profile, "DevToolsActivePort"),
        `${String(port)}\n/devtools/browser/x\n`,
      );
      return context as never;
    },
  };
  return { launcher, calls, closeFromOutside: () => onClose?.() };
};

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const START = {
  executablePath: "/usr/bin/chromium-browser",
  startUrl: "http://127.0.0.1:9/app",
  headless: false,
};

describe("BrowserSessionManager", () => {
  it("starts, lists targets, and closes with its profile removed", async () => {
    const { server, port } = await devtools();
    servers.push(server);
    const fake = fakeLauncher(port);
    const manager = new BrowserSessionManager({
      environment: { WAYLAND_DISPLAY: "wayland-0" },
      launcher: async () => fake.launcher,
    });

    const started = await manager.start(START);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.cdp_endpoint).toBe(`http://127.0.0.1:${String(port)}`);
    expect(started.value.start_navigation).toEqual({ status: "committed" });
    expect(fake.calls.goto).toEqual([START.startUrl]);

    const status = await manager.status(started.value.session_id);
    expect(status.ok && status.value).toMatchObject({
      state: "ready",
      targets_status: "listed",
      targets: [
        {
          target_id: "PAGE1",
          type: "page",
          url: "http://127.0.0.1:9/app",
          title: "App",
        },
      ],
    });

    const closed = await manager.close(started.value.session_id);
    expect(closed).toEqual({
      ok: true,
      value: { browser_closed: true, profile_removed: true },
    });
    expect(existsSync(fake.calls.profile)).toBe(false);
    // Closed sessions are forgotten.
    expect((await manager.status(started.value.session_id)).ok).toBe(false);
  });

  it("reports when the browser goes away without REA closing it", async () => {
    const { server, port } = await devtools();
    servers.push(server);
    const fake = fakeLauncher(port);
    const manager = new BrowserSessionManager({
      environment: { WAYLAND_DISPLAY: "wayland-0" },
      launcher: async () => fake.launcher,
    });
    const started = await manager.start(START);
    if (!started.ok) throw started.error;

    fake.closeFromOutside();
    const status = await manager.status(started.value.session_id);
    expect(status.ok && status.value.state).toBe("closed");
    expect(status.ok && status.value.ended_at).not.toBeNull();
    expect(status.ok && status.value.targets_status).toBe("not_running");

    // The browser is gone; close still removes the profile REA owns.
    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(true);
    expect(existsSync(fake.calls.profile)).toBe(false);
  });

  it("keeps a session whose cleanup failed so close can be retried", async () => {
    const { server, port } = await devtools();
    servers.push(server);
    const fake = fakeLauncher(port, { closeFails: true });
    const manager = new BrowserSessionManager({
      environment: { WAYLAND_DISPLAY: "wayland-0" },
      launcher: async () => fake.launcher,
    });
    const started = await manager.start(START);
    if (!started.ok) throw started.error;

    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(false);
    if (!closed.ok)
      expect(closed.error).toMatchObject({ reason: "cleanup_failed" });
    const status = await manager.status(started.value.session_id);
    expect(status.ok && status.value.state).toBe("cleanup_failed");
    // The profile isn't removed while the browser may still be using it.
    expect(existsSync(fake.calls.profile)).toBe(true);
  });

  it("refuses a window when REA has no display", async () => {
    const manager = new BrowserSessionManager({
      environment: {},
      launcher: async () => {
        throw new Error("must not launch");
      },
    });
    const started = await manager.start(START);
    expect(started.ok).toBe(false);
    if (!started.ok)
      expect(started.error.userMessage).toContain(
        "neither WAYLAND_DISPLAY nor DISPLAY",
      );
  });

  it("names Wayland for the window when REA has a Wayland socket", async () => {
    const { server, port } = await devtools();
    servers.push(server);
    const fake = fakeLauncher(port);
    let args: readonly string[] = [];
    const manager = new BrowserSessionManager({
      environment: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      launcher: async () => ({
        launchPersistentContext: async (dir, options) => {
          args = options?.args ?? [];
          return fake.launcher.launchPersistentContext(dir, options);
        },
      }),
    });
    const started = await manager.start(START);
    expect(started.ok).toBe(true);
    expect(args).toContain("--ozone-platform=wayland");
    if (started.ok) await manager.close(started.value.session_id);
  });

  it("removes the profile when the browser never starts", async () => {
    let profile = "";
    const manager = new BrowserSessionManager({
      environment: { WAYLAND_DISPLAY: "wayland-0" },
      launcher: async () => ({
        launchPersistentContext: async (dir) => {
          profile = dir;
          throw new Error("executable not found");
        },
      }),
    });
    const started = await manager.start(START);
    expect(started.ok).toBe(false);
    if (!started.ok)
      expect(started.error.userMessage).toContain("executable not found");
    expect(existsSync(profile)).toBe(false);
  });
});
