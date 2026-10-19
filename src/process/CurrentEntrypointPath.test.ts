import { describe, expect, it } from "vitest";

import { registrationEntrypointPath } from "./CurrentEntrypointPath.js";

describe("registration entrypoint", () => {
  it("registers the started script by default", () => {
    expect(registrationEntrypointPath({}, "/repo/scripts/rea.mjs")).toBe(
      "/repo/scripts/rea.mjs",
    );
    expect(
      registrationEntrypointPath(
        { REA_REGISTRATION_ENTRYPOINT: "" },
        "/repo/scripts/rea.mjs",
      ),
    ).toBe("/repo/scripts/rea.mjs");
  });

  it("registers the absolute launcher a wrapper names", () => {
    expect(
      registrationEntrypointPath(
        { REA_REGISTRATION_ENTRYPOINT: "/repo/container/rea" },
        "/repo/scripts/rea.mjs",
      ),
    ).toBe("/repo/container/rea");
  });

  it("registers nothing for a relative launcher", () => {
    expect(
      registrationEntrypointPath(
        { REA_REGISTRATION_ENTRYPOINT: "container/rea" },
        "/repo/scripts/rea.mjs",
      ),
    ).toBeUndefined();
  });
});
