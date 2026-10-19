// Hopper install. REA's setup owns the download, signature check and
// package install; this panel shows its plan, asks for approval and reports
// the outcome, including a layered Hopper that is waiting for a reboot.

import { apiJson } from "./api.js";
import { h } from "./render.js";

const INTRO =
  "Hopper is an optional commercial disassembler with a free demo; Ghidra and Kuna already cover native analysis without it. REA's setup downloads the official Hopper package, checks its signature and installs it with Xvfb, the virtual display it runs in.";

const PASSWORD_NOTE = {
  imageBased:
    "This system is image-based (rpm-ostree): the install layers the packages, Fedora asks for your password in its own window, and Hopper may only appear after a reboot.",
  other: "Your system asks for your password in its own window.",
};

const rebootNote = () =>
  h(
    "p",
    {},
    "Hopper is installed into the next system deployment. Restart your computer, then open Providers again.",
  );

function planView(plan) {
  return h(
    "div",
    { class: "hopper-plan" },
    h("p", {}, "Setup will run:"),
    h(
      "ul",
      {},
      plan.install.commands.map((command) =>
        h("li", {}, h("code", {}, command)),
      ),
    ),
    h("p", { class: "help" }, `Checked with: ${plan.install.integrity}`),
    plan.agents.length
      ? h(
          "p",
          { class: "help" },
          `It also refreshes REA's registration in: ${plan.agents.map((agent) => agent.label).join(", ")}. Each change is backed up first.`,
        )
      : null,
  );
}

/**
 * Renders the Hopper block. `ready` is rea doctor's verdict on Hopper;
 * onInstalled reruns the readiness check.
 */
export async function renderHopperPanel({ ready, onInstalled }) {
  const panel = h("div", { class: "hopper-panel" }, h("h4", {}, "Hopper"));
  if (ready) {
    panel.append(
      h("p", { class: "doctor-state-ready" }, "Installed and ready."),
    );
    return panel;
  }
  let host;
  try {
    host = await apiJson("/api/hopper");
  } catch (cause) {
    panel.append(h("p", { class: "form-error" }, cause.message));
    return panel;
  }
  if (host.pendingReboot) {
    panel.append(rebootNote());
    return panel;
  }
  if (host.platform !== "linux" && host.platform !== "darwin") {
    panel.append(
      h("p", { class: "hint" }, "Hopper isn't available on this system."),
    );
    return panel;
  }

  const body = h("div", {});
  const message = h("p", { class: "form-error", role: "alert" });
  const review = h("button", { type: "button" }, "Review Hopper install");
  panel.append(
    h("p", { class: "hint" }, INTRO),
    h(
      "p",
      { class: "hint" },
      host.imageBased ? PASSWORD_NOTE.imageBased : PASSWORD_NOTE.other,
    ),
    body,
    h("div", { class: "actions" }, review, message),
  );

  async function showResult(result) {
    if (result.status === "ready" && result.installed) return onInstalled();
    if (result.pendingReboot || result.code === "reboot_required") {
      body.replaceChildren(rebootNote());
      review.remove();
      return;
    }
    message.textContent = result.remediation ?? "Setup didn't install Hopper.";
    review.disabled = false;
    review.textContent = "Review Hopper install";
    review.onclick = startReview;
  }

  async function startReview() {
    message.textContent = "";
    review.disabled = true;
    review.textContent = "Planning…";
    let planned;
    try {
      planned = await apiJson("/api/hopper/plan", { method: "POST" });
    } catch (cause) {
      message.textContent = cause.message;
      review.disabled = false;
      review.textContent = "Review Hopper install";
      return;
    }
    if (!planned.plan.install) {
      message.textContent =
        planned.plan.remediation ?? "Setup has nothing to install for Hopper.";
      review.disabled = false;
      review.textContent = "Review Hopper install";
      return;
    }
    body.replaceChildren(planView(planned.plan));
    review.disabled = false;
    review.textContent = "Install Hopper";
    review.onclick = async () => {
      review.disabled = true;
      review.textContent = "Installing… approve the password prompt";
      try {
        await showResult(
          await apiJson("/api/hopper/install", {
            method: "POST",
            body: JSON.stringify({ fingerprint: planned.fingerprint }),
          }),
        );
      } catch (cause) {
        await showResult({ remediation: cause.message });
      }
    };
  }
  review.onclick = startReview;
  return panel;
}
