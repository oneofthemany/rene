import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { prlimitCeilingArguments } from "./LinuxResourceLimits.js";
import type { ArtifactAnalysisResources } from "./ArtifactAnalysisResources.js";
import type { BoundedToolNativeBound } from "./BoundedToolCommand.js";

/** One provider's admission terms for a caller-supplied native tool. */
export interface NativeToolBoundTerms {
  readonly provider: string;
  readonly operation: string;
  /** Environment key overriding /usr/bin/prlimit. */
  readonly limiterEnv: string;
  readonly limits: {
    readonly address_space_bytes: number;
    readonly file_bytes: number;
    readonly cpu_seconds: number;
  };
  readonly windowsMemoryBytes: number;
  /** Refusal on a host with neither prlimit nor Job Objects. */
  readonly unsupportedHost: string;
  /** Refusal when the selected prlimit cannot be established. */
  readonly limiterUnavailable: string;
}

/** Own native tool admission and the exact enforced resource profile. */
export const prepareNativeToolBound = async (
  terms: NativeToolBoundTerms,
  environment: Readonly<Record<string, string | undefined>>,
  resources: ArtifactAnalysisResources,
): Promise<{
  nativeBound: BoundedToolNativeBound;
  limitations: readonly string[];
}> => {
  const { provider, operation, limiterEnv } = terms;
  if (process.platform === "win32") {
    return {
      nativeBound: { memoryLimitBytes: terms.windowsMemoryBytes },
      limitations: [
        `Each owned Windows tool tree has a ${String(terms.windowsMemoryBytes / 1024 ** 3)} GiB Job Object committed-memory limit; this is not a machine-wide quota.`,
      ],
    };
  }
  if (process.platform !== "linux")
    throw new AnalysisCapabilityUnavailableError(
      provider,
      operation,
      terms.unsupportedHost,
      { userMessage: terms.unsupportedHost },
    );
  const configured = environment[limiterEnv] ?? "/usr/bin/prlimit";
  try {
    if (!isAbsolute(configured))
      throw new Error(`${limiterEnv} must be absolute.`);
    const limiter = await realpath(configured);
    await access(limiter, constants.X_OK);
    const limits = await resources.readLimits(terms.limits);
    return {
      nativeBound: {
        limiter: {
          command: limiter,
          arguments: prlimitCeilingArguments(limits),
        },
      },
      limitations: [
        `Linux prlimit preserves stricter inherited ceilings: ${limits.address_space_bytes} bytes of per-process address space, ${limits.file_bytes} bytes per file and ${limits.cpu_seconds} CPU seconds; core dumps are disabled. These are not aggregate machine quotas.`,
      ],
    };
  } catch (cause) {
    if (cause instanceof AnalysisError) throw cause;
    throw new AnalysisCapabilityUnavailableError(
      provider,
      operation,
      terms.limiterUnavailable,
      {
        cause,
        userMessage: `${terms.limiterUnavailable} (${cause instanceof Error ? cause.message : String(cause)}) Check that ${limiterEnv} (default /usr/bin/prlimit) names an absolute, executable util-linux prlimit.`,
      },
    );
  }
};
