import { isAbsolute, resolve } from "node:path";

/** Node's absolute argv script selection, or undefined when none was supplied.
 * Native executable paths have different traversal semantics and must not use this.
 */
export const normalizeEntrypointPath = (
  entrypoint: string | undefined,
): string | undefined =>
  entrypoint === undefined || entrypoint.length === 0
    ? undefined
    : resolve(entrypoint);

export const CURRENT_ENTRYPOINT_PATH = normalizeEntrypointPath(process.argv[1]);

/**
 * The launcher agents are registered to run. Normally the script this process
 * started from; a wrapper that starts REA indirectly (such as a container
 * launcher) names itself in REA_REGISTRATION_ENTRYPOINT, which must be an
 * absolute path. Setup, doctor and uninstall all identify REA's own
 * registrations by this path.
 */
export const registrationEntrypointPath = (
  environment: Readonly<NodeJS.ProcessEnv>,
  entrypoint: string | undefined,
): string | undefined => {
  const override = environment.REA_REGISTRATION_ENTRYPOINT;
  if (override === undefined || override === "")
    return normalizeEntrypointPath(entrypoint);
  return isAbsolute(override) ? normalizeEntrypointPath(override) : undefined;
};

export const REGISTRATION_ENTRYPOINT_PATH = registrationEntrypointPath(
  process.env,
  process.argv[1],
);
