// Hopper for the workbench.
//
// REA's `rea setup --install-hopper` owns Hopper: it downloads the official
// package, checks its PGP signature, retains the evidence `rea doctor` uses to
// accept the launcher later, and runs the system package manager. On
// rpm-ostree hosts that is `rpm-ostree install`, which asks for the user's
// password in the system's own dialog and may need a reboot. The workbench
// shows setup's plan, runs it after approval, and reports a layered Hopper
// that is waiting for a reboot.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Hopper download, signature check and package install can take a while. */
export const HOPPER_SETUP_TIMEOUT_MS = 20 * 60_000;

export const imageBased = () => existsSync("/run/ostree-booted");

/**
 * Whether a Hopper package is layered into a deployment that hasn't been
 * booted yet. Unknown (rpm-ostree missing or unreadable) counts as no.
 */
export async function hopperPendingReboot() {
  if (!imageBased()) return false;
  try {
    const { stdout } = await run("rpm-ostree", ["status", "--json"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const deployments = JSON.parse(stdout).deployments ?? [];
    const layersHopper = (deployment) =>
      (deployment?.["requested-local-packages"] ?? []).some((name) =>
        name.startsWith("hopper-"),
      );
    const booted = deployments.find((deployment) => deployment.booted);
    const pending = deployments[0];
    return (
      pending !== undefined &&
      !pending.booted &&
      layersHopper(pending) &&
      !layersHopper(booted)
    );
  } catch {
    return false;
  }
}

/** The parts of a setup plan a person needs to approve a Hopper install. */
export function describeHopperPlan(report) {
  const actions = report.plannedActions ?? [];
  const install = actions.find((action) => action.kind === "install_hopper");
  return {
    install: install && {
      detail: install.detail,
      commands: install.commands ?? [],
      networkOrigins: install.networkOrigins ?? [],
      integrity: install.integrity,
    },
    // Setup also refreshes REA's registration in agents it already set up,
    // so they get Hopper's launcher path.
    agents: actions
      .filter((action) => action.kind === "configure_client")
      .map((action) => ({
        label: action.label,
        target: action.target,
        operation: action.operation,
      })),
    status: report.status,
    remediation: report.remediation,
  };
}

/** HTTP routes; setup runs through the bridge's shared one-at-a-time runner. */
export function hopperRoutes({
  runSetup,
  planFingerprint,
  exclusiveSetup,
  readJsonBody,
  sendJson,
}) {
  const PLAN = ["--dry-run", "--install-hopper"];
  return {
    "GET /api/hopper": async (_request, response) =>
      sendJson(response, 200, {
        platform: process.platform,
        imageBased: imageBased(),
        pendingReboot: await hopperPendingReboot(),
      }),

    "POST /api/hopper/plan": (_request, response) =>
      exclusiveSetup(response, async () => {
        const report = await runSetup(PLAN);
        return sendJson(response, 200, {
          plan: describeHopperPlan(report),
          fingerprint: planFingerprint(report),
        });
      }),

    /** Applies the reviewed plan, refusing if a fresh plan no longer matches it. */
    "POST /api/hopper/install": async (request, response) => {
      const fingerprint = (await readJsonBody(request))?.fingerprint;
      if (typeof fingerprint !== "string")
        return sendJson(response, 400, {
          error: "Expected { fingerprint: string }.",
        });
      return exclusiveSetup(response, async () => {
        const fresh = await runSetup(PLAN);
        if (planFingerprint(fresh) !== fingerprint)
          return sendJson(response, 409, {
            error:
              "The plan changed since you reviewed it. Review the new plan before installing.",
            plan: describeHopperPlan(fresh),
            fingerprint: planFingerprint(fresh),
          });
        const report = await runSetup(
          ["--yes", "--install-hopper"],
          HOPPER_SETUP_TIMEOUT_MS,
        );
        return sendJson(response, 200, {
          status: report.status,
          code: report.code,
          remediation: report.remediation,
          installed: (report.appliedActions ?? []).includes("installed_hopper"),
          pendingReboot: await hopperPendingReboot(),
        });
      });
    },
  };
}
