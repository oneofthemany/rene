import { describe, expect, it } from "vitest";

import {
  ADB_BINARY_ENV,
  parseAdbVersionOutput,
  resolveAdbBinary,
} from "./AdbConfiguration.js";

describe("resolveAdbBinary", () => {
  it("prefers an absolute REA_ADB_PATH", () => {
    expect(resolveAdbBinary({ [ADB_BINARY_ENV]: "/opt/tools/adb" })).toEqual({
      binary: "/opt/tools/adb",
      pathSource: "environment",
    });
  });

  it("falls back to PATH resolution without the environment key", () => {
    expect(resolveAdbBinary({})).toEqual({
      binary: "adb",
      pathSource: "path",
    });
    expect(resolveAdbBinary({ [ADB_BINARY_ENV]: "  " })).toEqual({
      binary: "adb",
      pathSource: "path",
    });
  });

  it("rejects a relative environment path explicitly", () => {
    expect(() => resolveAdbBinary({ [ADB_BINARY_ENV]: "tools/adb" })).toThrow(
      /must be an absolute path/u,
    );
  });
});

describe("parseAdbVersionOutput", () => {
  it("reads the build version and install path from real output", () => {
    expect(
      parseAdbVersionOutput(
        [
          "Android Debug Bridge version 1.0.41",
          "Version 34.0.5-debian",
          "Installed as /usr/lib/android-sdk/platform-tools/adb",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      version: "34.0.5-debian",
      installedPath: "/usr/lib/android-sdk/platform-tools/adb",
    });
  });

  it("reads a distribution build version suffixed without a separator", () => {
    expect(
      parseAdbVersionOutput(
        [
          "Android Debug Bridge version 1.0.41",
          "Version 37.0.0p1-android-tools",
          "Installed as /usr/bin/adb",
          "Running on Linux 7.2.11-200.fc44.x86_64 (x86_64)",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      version: "37.0.0p1-android-tools",
      installedPath: "/usr/bin/adb",
    });
  });

  it("reports null identity fields when the named lines are absent", () => {
    expect(parseAdbVersionOutput("unexpected output")).toEqual({
      version: null,
      installedPath: null,
    });
  });

  it("does not accept arbitrary successful output as an adb version", () => {
    expect(
      parseAdbVersionOutput(
        "Android Debug Bridge version tomorrow\nVersion unknown\n",
      ),
    ).toMatchObject({ version: null });
  });
});
