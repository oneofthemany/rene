// Path picker for fields REA declares as local host paths. The bridge lists
// directories; nothing here reads a file.

import { apiJson } from "./api.js";
import { h } from "./render.js";

/** REA's localPathStringSchema: a NUL-free string naming a path on this host. */
export function isLocalPath(schema) {
  return schema?.type === "string" && schema.pattern === "^[^\\x00]*$";
}

/** Fields whose value is a directory, not a file. */
export function wantsFolder(name) {
  return /(^|_)(root|directory|dir)$/.test(name);
}

let dialog;
let showHidden = false;

/**
 * Opens the picker at `start` (or home). `onPick` receives the chosen
 * absolute path; folder mode offers only folders.
 */
export function openPicker({ start, folder, onPick }) {
  dialog ??= document.body.appendChild(
    h("dialog", { class: "picker", "aria-label": "Choose a path" }),
  );
  const state = { folder, onPick, listing: undefined, selected: undefined };
  dialog.replaceChildren();
  dialog.showModal();
  void load(state, start && start.startsWith("/") ? start : undefined);
}

async function load(state, path) {
  let listing;
  try {
    listing = await apiJson("/api/fs/list", {
      method: "POST",
      body: JSON.stringify(path === undefined ? {} : { path }),
    });
  } catch (cause) {
    if (state.listing) {
      render(state, cause.message);
      return;
    }
    // A typed start path that no longer exists falls back to home.
    if (path !== undefined) return load(state, undefined);
    dialog.replaceChildren(h("p", { class: "form-error" }, cause.message));
    return;
  }
  state.listing = listing;
  state.selected = undefined;
  render(state);
}

function join(directory, name) {
  return directory === "/" ? `/${name}` : `${directory}/${name}`;
}

function crumbs(state) {
  const parts = state.listing.path.split("/").filter(Boolean);
  const links = [
    h(
      "button",
      { type: "button", class: "link", onclick: () => load(state, "/") },
      "/",
    ),
  ];
  parts.forEach((part, index) => {
    const target = `/${parts.slice(0, index + 1).join("/")}`;
    links.push(
      h(
        "button",
        { type: "button", class: "link", onclick: () => load(state, target) },
        part,
      ),
      index < parts.length - 1 ? h("span", { class: "picker-sep" }, "/") : "",
    );
  });
  return h(
    "nav",
    { class: "picker-crumbs", "aria-label": "Current folder" },
    links,
  );
}

function render(state, problem) {
  const { listing, folder } = state;
  const typed = h("input", {
    class: "picker-typed",
    value: listing.path,
    spellcheck: "false",
    "aria-label": "Folder path",
  });
  typed.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void load(state, typed.value.trim());
    }
  });
  const choose = h("button", { type: "button", class: "primary" });
  const refreshChoose = () => {
    const file = state.selected;
    choose.textContent = file ? `Use ${file.name}` : "Use this folder";
    choose.title = file ? join(listing.path, file.name) : listing.path;
  };
  choose.addEventListener("click", () => {
    state.onPick(
      state.selected ? join(listing.path, state.selected.name) : listing.path,
    );
    dialog.close();
  });

  const visible = listing.entries.filter(
    (entry) =>
      (showHidden || !entry.name.startsWith(".")) &&
      (!folder || entry.type === "dir"),
  );
  const rows = visible.map((entry) => {
    const isDir = entry.type === "dir";
    const item = h(
      "button",
      {
        type: "button",
        class: `picker-entry picker-${entry.type}`,
        "aria-pressed": "false",
        title: entry.link ? "Symbolic link" : undefined,
      },
      h(
        "span",
        { class: "picker-icon", "aria-hidden": "true" },
        isDir ? "▸" : "·",
      ),
      entry.name,
      entry.link ? h("span", { class: "picker-link" }, " →") : "",
    );
    // Folders open on click; a file is selected, then used or opened twice.
    item.addEventListener("click", () => {
      if (isDir) return void load(state, join(listing.path, entry.name));
      if (entry.type !== "file") return;
      for (const other of rows)
        other.firstChild.setAttribute("aria-pressed", "false");
      item.setAttribute("aria-pressed", "true");
      state.selected = entry;
      refreshChoose();
    });
    item.addEventListener("dblclick", () => {
      if (entry.type !== "file") return;
      state.onPick(join(listing.path, entry.name));
      dialog.close();
    });
    return h("li", {}, item);
  });
  refreshChoose();

  const hidden = h("input", { type: "checkbox", checked: showHidden });
  hidden.addEventListener("change", () => {
    showHidden = hidden.checked;
    render(state);
  });

  dialog.replaceChildren(
    h(
      "div",
      { class: "picker-head" },
      h("h2", {}, folder ? "Choose a folder" : "Choose a file or folder"),
      h(
        "button",
        { type: "button", class: "quiet", onclick: () => dialog.close() },
        "Cancel",
      ),
    ),
    crumbs(state),
    h(
      "div",
      { class: "picker-tools" },
      listing.parent
        ? h(
            "button",
            {
              type: "button",
              class: "quiet",
              onclick: () => load(state, listing.parent),
            },
            "Up",
          )
        : "",
      h(
        "button",
        {
          type: "button",
          class: "quiet",
          onclick: () => load(state, listing.home),
        },
        "Home",
      ),
      typed,
      h("label", { class: "picker-hidden" }, hidden, " Hidden"),
    ),
    problem ? h("p", { class: "form-error", role: "alert" }, problem) : "",
    h(
      "ul",
      { class: "picker-list" },
      rows.length
        ? rows
        : h(
            "li",
            { class: "hint" },
            folder ? "No folders here." : "Empty folder.",
          ),
    ),
    listing.truncated
      ? h(
          "p",
          { class: "hint" },
          "Only the first 5000 entries are listed; type a path to go deeper.",
        )
      : "",
    h("div", { class: "actions picker-actions" }, choose),
  );
}
