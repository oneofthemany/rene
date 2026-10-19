// Projects: the folder bar in the middle column and the Project tab (the
// active folder's assessment, and the other folders to switch to).
//
// The active project decides which history the page shows and records into,
// and where the agent starts. The bridge owns projects; this module only asks
// it to open folders and shows what it returns. While an agent runs, the
// project is the agent's and can't be changed here.

import { apiJson } from "./api.js";
import { openPicker } from "./browse.js";
import { renderMarkdown } from "./markdown.js";
import { h } from "./render.js";

const PROJECT_KEY = "rea-project";

const remembered = (value) => {
  try {
    if (value === undefined)
      return localStorage.getItem(PROJECT_KEY) ?? undefined;
    if (value === null) localStorage.removeItem(PROJECT_KEY);
    else localStorage.setItem(PROJECT_KEY, value);
  } catch {
    return undefined;
  }
};

const FOLDER_STATE = {
  missing: "Folder not found",
  replaced: "A different folder is at this path now",
};

/**
 * @param {{ onChange: (project) => void, onShowProjects: () => void }} hooks
 *   onChange hears every change of active project (undefined for none).
 */
/**
 * An assessment as a document, or as its raw markdown. Built from DOM nodes
 * only: the file's text never becomes markup.
 */
export function assessmentDocument(text, raw = false) {
  return raw
    ? h("pre", { class: "assessment-text" }, text)
    : h("div", { class: "assessment-doc" }, renderMarkdown(text));
}

export function initProjects({ onChange, onShowProjects, onOpenAssessment }) {
  const input = document.getElementById("project-path");
  const message = document.getElementById("project-message");
  const assessmentNote = document.getElementById("project-assessment");
  const panel = document.getElementById("panel-project");
  const state = {
    running: false,
    raw: false,
    current: undefined,
    list: [],
    locked: undefined,
    assessment: undefined,
  };

  const setBusy = (busy) => {
    for (const id of ["project-path", "project-browse", "project-open"])
      document.getElementById(id).disabled = busy || Boolean(state.locked);
  };

  function activate(project) {
    state.current = project;
    state.assessment = undefined;
    input.value = project?.path ?? "";
    remembered(project ? project.id : null);
    renderBar();
    onChange(project);
    void refresh();
  }

  async function open(path) {
    message.textContent = "";
    if (!path) return;
    setBusy(true);
    try {
      activate(
        await apiJson("/api/projects/open", {
          method: "POST",
          body: JSON.stringify({ path }),
        }),
      );
    } catch (cause) {
      message.textContent = cause.message;
    } finally {
      setBusy(false);
    }
  }

  document
    .getElementById("project-open")
    .addEventListener("click", () => open(input.value.trim()));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void open(input.value.trim());
    }
  });
  document.getElementById("project-browse").addEventListener("click", () =>
    openPicker({
      start: input.value || undefined,
      folder: true,
      onPick: (path) => void open(path),
    }),
  );

  function renderBar() {
    const choice = state.current?.assessment;
    assessmentNote.replaceChildren(
      !state.current
        ? "No project: calls go to the unassigned history."
        : choice === "ask"
          ? h(
              "button",
              { type: "button", class: "link", onclick: onShowProjects },
              "Set up a project assessment",
            )
          : choice === "enabled"
            ? "Assessment kept in .rene/assessment.md"
            : "No assessment for this project",
    );
    setBusy(false);
  }

  async function chooseAssessment(enabled) {
    const project = state.current;
    try {
      state.assessment = await apiJson(
        `/api/projects/${project.id}/assessment`,
        { method: "POST", body: JSON.stringify({ enabled }) },
      );
      project.assessment = state.assessment.choice;
      renderBar();
      onChange(project);
    } catch (cause) {
      state.assessment = { error: cause.message, choice: project.assessment };
    }
    renderPanel();
  }

  function assessmentSection() {
    const project = state.current;
    if (!project) return null;
    const assessment = state.assessment;
    const body = [];
    if (assessment?.error)
      body.push(h("p", { class: "form-error" }, assessment.error));
    if (project.assessment === "ask")
      body.push(
        h(
          "p",
          {},
          "Keep a project assessment in ",
          h("code", {}, ".rene/assessment.md"),
          " in this folder? It's markdown project memory for you and your agent: target, rules, findings and open questions, plus a section the workbench rewrites from the folder survey (structure, file types, the tools that apply) and the recorded tool calls (pathways and links confirmed by Evidence ID, tools used). The agent reads it when it starts here.",
        ),
        h(
          "div",
          { class: "actions" },
          h(
            "button",
            {
              type: "button",
              class: "primary",
              onclick: () => chooseAssessment(true),
            },
            "Create it",
          ),
          h(
            "button",
            {
              type: "button",
              class: "quiet",
              onclick: () => chooseAssessment(false),
            },
            "Not for this project",
          ),
        ),
      );
    else if (project.assessment === "declined")
      body.push(
        h("p", { class: "hint" }, "Nothing is written into this folder."),
        h(
          "button",
          {
            type: "button",
            class: "quiet",
            onclick: () => chooseAssessment(true),
          },
          "Keep an assessment",
        ),
      );
    else if (!assessment) body.push(h("p", { class: "hint" }, "Loading…"));
    else if (assessment.text === undefined)
      body.push(
        h(
          "p",
          { class: "hint" },
          `${assessment.file ?? ".rene/assessment.md"} isn't there yet; Run assessment now writes it.`,
        ),
      );
    else
      body.push(
        h(
          "div",
          { class: "assessment-tools" },
          h(
            "span",
            { class: "hint", title: assessment.file },
            ".rene/assessment.md",
          ),
          h(
            "button",
            {
              type: "button",
              class: "link",
              onclick: () => {
                state.raw = !state.raw;
                renderPanel();
              },
            },
            state.raw ? "Formatted" : "Markdown",
          ),
          h(
            "button",
            {
              type: "button",
              class: "link",
              title: "Show the assessment full width in the middle column",
              onclick: () => onOpenAssessment?.(project, assessment),
            },
            "Full view",
          ),
        ),
        assessmentDocument(assessment.text, state.raw),
      );
    return h(
      "section",
      { class: "assessment" },
      h(
        "div",
        { class: "assessment-head" },
        h("h3", {}, "Assessment"),
        h(
          "button",
          {
            type: "button",
            class: "quiet",
            disabled: state.running,
            title:
              "Survey the folder with survey_project_directory now and rebuild the assessment. The workbench also does this when the folder is opened and in the background after calls.",
            onclick: runAssessment,
          },
          state.running ? "Surveying…" : "Run assessment now",
        ),
      ),
      body,
    );
  }

  /** Surveys the folder now; the call lands in History like any other. */
  async function runAssessment() {
    const project = state.current;
    if (!project || state.running) return;
    state.running = true;
    renderPanel();
    try {
      state.assessment = await apiJson(
        `/api/projects/${project.id}/assessment/run`,
        { method: "POST" },
      );
    } catch (cause) {
      state.assessment = { ...state.assessment, error: cause.message };
    } finally {
      state.running = false;
      state.drawn = undefined;
      renderPanel();
    }
  }

  function projectItem(project) {
    const active = project.id === state.current?.id;
    return h(
      "li",
      { "aria-current": String(active) },
      h(
        "button",
        {
          type: "button",
          class: "p-open",
          disabled: Boolean(state.locked) && !active,
          title: project.path,
          onclick: () => (active ? undefined : open(project.path)),
        },
        h("span", { class: "p-name" }, project.name),
        h("span", { class: "p-path" }, project.path),
        project.folder !== "present"
          ? h("span", { class: "p-warn" }, FOLDER_STATE[project.folder])
          : null,
      ),
    );
  }

  /** Rebuilds the tab, keeping where the reader had scrolled. */
  function renderPanel() {
    const scroll = panel.querySelector(
      ".assessment-text, .assessment-doc",
    )?.scrollTop;
    renderPanelContent();
    const text = panel.querySelector(".assessment-text, .assessment-doc");
    if (text && scroll !== undefined) text.scrollTop = scroll;
  }

  function renderPanelContent() {
    panel.replaceChildren(
      ...[
        assessmentSection(),
        h("h3", {}, "Other projects"),
        state.locked
          ? h(
              "p",
              { class: "hint" },
              "An agent is running; stop it to switch projects.",
            )
          : null,
        state.list.length
          ? h("ol", { class: "project-list" }, state.list.map(projectItem))
          : h("p", { class: "hint" }, "Folders you open appear here."),
        h(
          "button",
          {
            type: "button",
            class: "link",
            disabled: Boolean(state.locked) || !state.current,
            onclick: () => activate(undefined),
          },
          "Show unassigned calls",
        ),
      ].filter(Boolean),
    );
  }

  async function refresh() {
    const project = state.current;
    const [{ projects }, assessment] = await Promise.all([
      apiJson("/api/projects").catch(() => ({ projects: [] })),
      project
        ? apiJson(`/api/projects/${project.id}/assessment`).catch((cause) => ({
            error: cause.message,
          }))
        : undefined,
    ]);
    // Nothing changed: the tab stays exactly as it is.
    const drawn = JSON.stringify([projects, assessment, state.locked]);
    if (project === state.current && drawn === state.drawn) return;
    state.list = projects;
    if (project === state.current) state.assessment = assessment;
    state.drawn = drawn;
    renderPanel();
  }

  return {
    current: () => state.current,
    refresh,
    /** Restores the remembered project, or the running agent's. */
    async restore(agentProject) {
      const { projects } = await apiJson("/api/projects").catch(() => ({
        projects: [],
      }));
      state.list = projects;
      const id = agentProject ?? remembered();
      const project = projects.find((candidate) => candidate.id === id);
      // Opened through the bridge, which refreshes the folder's identity and
      // rebuilds the assessment from the stored history.
      if (project && project.folder === "present") await open(project.path);
      else activate(undefined);
    },
    /**
     * Follows the agent: while one runs, its project is active and fixed.
     * `project` is the running agent's project id, or undefined.
     */
    async lock(project) {
      state.locked = project;
      if (project && project !== state.current?.id) {
        await refresh();
        const found = state.list.find((candidate) => candidate.id === project);
        if (found) activate(found);
      }
      renderBar();
      renderPanel();
    },
    /** A bridge event: the assessment of `project` was rewritten. */
    assessmentChanged(project) {
      if (project === state.current?.id) void refresh();
    },
  };
}
