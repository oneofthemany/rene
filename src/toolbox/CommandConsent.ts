/**
 * Which shell commands an agent may run only with the user's consent.
 *
 * rene's run_command is open: an agent builds, tests, reads git history and
 * runs the project's own scripts without asking. The user's rule limits it
 * on security and intent alone: nothing is installed, downloaded or
 * launched, no cloud service is acted on, and nothing privileged,
 * destructive or credential-reading runs, unless the user agrees to that
 * command. Both the workbench's topic gate (frontend/topicGate.mjs, which
 * turns this into Claude Code's own approval prompt) and `rene agent`
 * (which asks on its terminal) apply it.
 *
 * Like the git rule (GitHistory.ts), a line is split conservatively at
 * every shell separator, command substitution included, so a command nested
 * in $(…) or `…` is seen too: for a consent rule, asking too often is the
 * safe side.
 */

const SEPARATORS = /&&|\|\||[;\n&()`]|\$\(/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** A set of words written as one space-separated string. */
const words = (text: string): ReadonlySet<string> =>
  new Set(text.trim().split(/\s+/u));

const WRAPPERS = words("env time nice nohup command exec");
const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** One simple command: its program, the words after it, and its first non-option word. */
interface Command {
  readonly program: string;
  readonly rest: readonly string[];
  readonly sub: string;
}

/** The simple commands of a line, assignments and wrappers (env, time, nohup) set aside. */
const commandsOf = (line: string): Command[] =>
  line.split(SEPARATORS).flatMap((segment) => {
    const parts = segment.trim().split(/\s+/u).filter(Boolean);
    let start = 0;
    while (
      start < parts.length &&
      (ASSIGNMENT.test(parts[start] as string) ||
        WRAPPERS.has(basename(parts[start] as string)))
    )
      start += 1;
    if (parts.length <= start) return [];
    const rest = parts.slice(start + 1);
    return [
      {
        program: basename(parts[start] as string),
        rest,
        sub: rest.find((word) => !word.startsWith("-")) ?? "",
      },
    ];
  });

const has = (list: readonly string[], options: ReadonlySet<string>) =>
  list.some((word) => options.has(word));

const PRIVILEGE = words("sudo su doas pkexec run0");
const PACKAGE_CHANGES = words(`install i add ci update upgrade up uninstall
  remove rm erase purge reinstall dist-upgrade full-upgrade sync link global`);
const PACMAN_CHANGES = words("-S -Syu -U -R");
const SYSTEM_PACKAGES = words(`apt apt-get aptitude dnf yum microdnf zypper
  pacman yay paru apk emerge brew port rpm-ostree nix-env winget choco scoop`);
const RPM_CHANGES = words("-i -U -e --install --erase");
const APP_STORES = words("flatpak snap");
const JS_PACKAGES = words("npm pnpm yarn bun");
const JS_REGISTRY_RUNS = words("dlx exec x create");
const REGISTRY_RUNNERS = words("npx pnpx bunx uvx");
const LOCAL_ONLY = words("--no-install --offline --no");
const PYTHON_PACKAGES = words(
  "pip pip3 pipx uv poetry conda mamba micromamba pdm",
);
const LANGUAGE_TOOLS = words("cargo go gem sdk asdf mise nvm volta");
const LANGUAGE_INSTALLS = words("install get add toolchain update use plugin");
const CONTAINERS = words("podman docker nerdctl buildah skopeo");
const CONTAINER_CHANGES = words(
  "pull run build create start exec compose load import push play kube",
);
const DOWNLOADERS = words("wget aria2c yt-dlp");
const CURL_FILES = words(
  "-o -O --output --remote-name --remote-name-all -T --upload-file",
);
const CLOUD = words(`aws gcloud gsutil bq az kubectl helm terraform tofu
  pulumi flyctl fly heroku vercel netlify doctl oci wrangler firebase eksctl
  kind minikube`);
const APP_LAUNCHERS = words(
  "xdg-open open gtk-launch kioclient kde-open gnome-open",
);
const SERVICES = words("systemctl service launchctl rc-service");
const SERVICE_CHANGES = words(
  "start restart enable load bootstrap kickstart reload --now",
);
const SCHEDULERS = words("crontab at batch");
const DISK_TOOLS = words("fdisk sfdisk parted wipefs mkswap shred blkdiscard");
const REMOVERS = words("rm rmdir");
const PERMISSIONS = words("chmod chown chgrp");
const FETCHERS = words("curl wget fetch");
const INTERPRETERS = words(
  "sh bash zsh dash fish ksh python python3 node perl ruby pwsh",
);
const CREDENTIALS =
  /(?:^|[\s'"=/])(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+|\/root)\/(?:\.ssh\/|\.aws\/|\.gnupg\/|\.kube\/config|\.docker\/config\.json|\.netrc|\.git-credentials|\.config\/gh\/hosts|\.config\/gcloud\/|\.azure\/)/u;
const HOME_OR_ROOT =
  /^(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$HOME\/\*|\$\{HOME\}|\$\{HOME\}\/|\$\{HOME\}\/\*|\/home|\/home\/[^/]+\/?)$/u;
const RECURSIVE = /^-[A-Za-z]*[rR]/u;
const CURL_FILE_FLAGS = /^-[A-Za-z]*[oOT][A-Za-z]*$/u;

const recursiveOverHome = ({ rest }: Command) =>
  rest.some((word) => RECURSIVE.test(word) || word === "--recursive") &&
  rest.some((word) => HOME_OR_ROOT.test(word));

const pythonPackageChange = ({ program, rest, sub }: Command) =>
  (PYTHON_PACKAGES.has(program) &&
    (PACKAGE_CHANGES.has(sub) || sub === "tool" || sub === "env")) ||
  (program.startsWith("python") &&
    rest[0] === "-m" &&
    (rest[1] === "ensurepip" ||
      (rest[1] === "pip" && PACKAGE_CHANGES.has(rest[2] ?? ""))));

/** The consent rules, in order: a command matching one needs consent, for its reason. */
const RULES: readonly {
  readonly reason: string;
  readonly applies: (command: Command) => boolean;
}[] = [
  {
    reason: "it runs with administrator rights",
    applies: ({ program }) => PRIVILEGE.has(program),
  },
  {
    reason: "it installs or changes system packages",
    applies: ({ program, rest, sub }) =>
      (SYSTEM_PACKAGES.has(program) &&
        (PACKAGE_CHANGES.has(sub) || has(rest, PACMAN_CHANGES))) ||
      (program === "rpm" && has(rest, RPM_CHANGES)),
  },
  {
    reason: "it installs or runs an application",
    applies: ({ program, sub }) =>
      APP_STORES.has(program) && (PACKAGE_CHANGES.has(sub) || sub === "run"),
  },
  {
    reason: "it installs or changes packages",
    applies: ({ program, sub }) =>
      JS_PACKAGES.has(program) && PACKAGE_CHANGES.has(sub),
  },
  {
    reason: "it runs a package fetched from the registry",
    applies: ({ program, rest, sub }) =>
      (JS_PACKAGES.has(program) && JS_REGISTRY_RUNS.has(sub)) ||
      (REGISTRY_RUNNERS.has(program) && !has(rest, LOCAL_ONLY)),
  },
  {
    reason: "it installs or changes Python packages",
    applies: pythonPackageChange,
  },
  {
    reason: "it installs a tool or toolchain",
    applies: ({ program, sub }) =>
      program === "rustup" ||
      (LANGUAGE_TOOLS.has(program) && LANGUAGE_INSTALLS.has(sub)),
  },
  {
    reason: "it fetches, builds or runs a container",
    applies: ({ program, sub }) =>
      CONTAINERS.has(program) && CONTAINER_CHANGES.has(sub),
  },
  {
    reason: "it downloads files",
    applies: ({ program }) => DOWNLOADERS.has(program),
  },
  {
    reason: "it downloads or uploads a file",
    applies: ({ program, rest }) =>
      program === "curl" &&
      (has(rest, CURL_FILES) ||
        rest.some((word) => CURL_FILE_FLAGS.test(word))),
  },
  {
    reason: "it downloads a repository",
    applies: ({ program, sub }) =>
      program === "git" && (sub === "clone" || sub === "submodule"),
  },
  {
    reason: "it acts on a cloud service",
    applies: ({ program }) => CLOUD.has(program),
  },
  {
    reason: "it opens an application",
    applies: ({ program, sub }) =>
      APP_LAUNCHERS.has(program) || (program === "gio" && sub === "open"),
  },
  {
    reason: "it starts or enables a service",
    applies: ({ program, rest, sub }) =>
      SERVICES.has(program) &&
      (SERVICE_CHANGES.has(sub) || rest.includes("--now")),
  },
  {
    reason: "it changes scheduled jobs",
    applies: ({ program, rest }) =>
      SCHEDULERS.has(program) && !rest.includes("-l"),
  },
  {
    reason: "it can erase a disk or partition",
    applies: ({ program }) =>
      DISK_TOOLS.has(program) || program.startsWith("mkfs"),
  },
  {
    reason: "it writes to a raw device",
    applies: ({ program, rest }) =>
      program === "dd" && rest.some((word) => word.startsWith("of=/dev/")),
  },
  {
    reason: "it deletes the home folder or the whole file system",
    applies: (command) =>
      REMOVERS.has(command.program) && recursiveOverHome(command),
  },
  {
    reason:
      "it changes ownership or permissions across the home folder or the whole file system",
    applies: (command) =>
      PERMISSIONS.has(command.program) && recursiveOverHome(command),
  },
];

/** Whether something fetched is piped straight into an interpreter. */
const pipesFetchIntoInterpreter = (line: string) => {
  const programs = line
    .split("|")
    .map((part) => basename(part.trim().split(/\s+/u)[0] ?? ""));
  return programs.some(
    (into, index) =>
      index > 0 &&
      INTERPRETERS.has(into) &&
      FETCHERS.has(programs[index - 1] as string),
  );
};

/**
 * Why a shell command line needs the user's consent before it runs: the
 * first reason found, or undefined when it may run as it is.
 */
export const consentNeeded = (line: string): string | undefined => {
  if (pipesFetchIntoInterpreter(line))
    return "it runs a script fetched from the network";
  if (CREDENTIALS.test(line))
    return "it reads or uses stored credentials (keys, tokens or cloud logins)";
  if (line.includes(":|:&")) return "it looks like a fork bomb";
  for (const command of commandsOf(line))
    for (const rule of RULES) if (rule.applies(command)) return rule.reason;
  return undefined;
};

/** What an agent is told when a command needs consent it couldn't get. */
export const CONSENT_RULE =
  "rene runs commands that install, download or launch software, act on a cloud service, or run privileged, destructive or credential-reading commands only with the user's consent for that command.";
