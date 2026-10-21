import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { PROVIDER_SETTING_NAMES } from "../../src/toolbox/SavedProviderSettings.js";
import { withWorkbenchSettings } from "../../src/toolCli.js";

// Provider paths saved on the workbench's Providers page: one file, read by
// the bridge (frontend/settings.mjs) for REA and its agent sessions, and by
// rene run by hand, through one owner (src/toolbox/SavedProviderSettings.ts).

const frontend = new URL("../../frontend/", import.meta.url);
const { PROVIDER_SETTINGS, createSettings } = (await import(
  new URL("settings.mjs", frontend).href
)) as {
  PROVIDER_SETTINGS: readonly { name: string }[];
  createSettings(path: string): {
    load(): Promise<void>;
    environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    describe(base: NodeJS.ProcessEnv): { loadError?: string };
  };
};

const savedFile = async (content: string) => {
  const directory = await createTestTempDirectory("rea-settings-");
  const path = join(directory, "settings.json");
  await writeFile(path, content);
  return path;
};

const SAVED = JSON.stringify({
  environment: {
    GHIDRA_INSTALL_DIR: "/saved/ghidra",
    REA_ANALYSIS_PROVIDER: "ghidra",
    // Not a provider setting, and not a string: both ignored.
    PATH: "/saved/bin",
    JAVA_HOME: 17,
  },
  use: { ida: false },
});

it("the page offers exactly the variables the file may set", () => {
  expect(PROVIDER_SETTINGS.map(({ name }) => name).sort()).toEqual(
    [...PROVIDER_SETTING_NAMES].sort(),
  );
});

it("the bridge applies saved paths over its own environment", async () => {
  const settings = createSettings(await savedFile(SAVED));
  await settings.load();
  const env = settings.environment({
    GHIDRA_INSTALL_DIR: "/shell/ghidra",
    PATH: "/shell/bin",
  });
  expect(env).toMatchObject({
    GHIDRA_INSTALL_DIR: "/saved/ghidra",
    REA_ANALYSIS_PROVIDER: "ghidra",
    PATH: "/shell/bin",
  });
  expect(env.JAVA_HOME).toBeUndefined();
});

it("rene run by hand applies saved paths its caller doesn't set", async () => {
  const path = await savedFile(SAVED);
  const errors: string[] = [];
  const io = withWorkbenchSettings(
    {
      env: { REA_ANALYSIS_PROVIDER: "hopper", GHIDRA_INSTALL_DIR: "" },
      writeStdout: () => undefined,
      writeStderr: (text) => errors.push(text),
      readStdin: async () => "",
    },
    "/no/such/default.json",
  );
  // The default path holds nothing; REA_WORKBENCH_SETTINGS wasn't set.
  expect(io.env).toEqual({
    REA_ANALYSIS_PROVIDER: "hopper",
    GHIDRA_INSTALL_DIR: "",
  });
  const named = withWorkbenchSettings(
    { ...io, env: { ...io.env, REA_WORKBENCH_SETTINGS: path } },
    "/no/such/default.json",
  );
  // The caller's own value wins; an empty one counts as unset.
  expect(named.env).toMatchObject({
    REA_ANALYSIS_PROVIDER: "hopper",
    GHIDRA_INSTALL_DIR: "/saved/ghidra",
  });
  expect(named.env.PATH).toBeUndefined();
  expect(errors).toEqual([]);
});

it("a settings file that isn't JSON applies nothing and says so", async () => {
  const path = await savedFile("{ not json");
  const errors: string[] = [];
  const io = withWorkbenchSettings(
    {
      env: {},
      writeStdout: () => undefined,
      writeStderr: (text) => errors.push(text),
      readStdin: async () => "",
    },
    path,
  );
  expect(io.env).toEqual({});
  expect(errors.join("")).toContain("saved provider paths aren't applied");
  const settings = createSettings(path);
  await settings.load();
  expect(settings.describe({}).loadError).toContain("could not be read");
});
