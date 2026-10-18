import type { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import { prepareNativeToolBound } from "../process/NativeToolBound.js";

const PCAP_BOUND = {
  provider: "pcap",
  operation: "inspect_pcap_capture",
  limiterEnv: "REA_TSHARK_PRLIMIT_COMMAND",
  limits: {
    address_space_bytes: 1024 ** 3,
    file_bytes: 64 * 1024 ** 2,
    cpu_seconds: 300,
  },
  windowsMemoryBytes: 1024 ** 3,
  unsupportedHost:
    "Packet summaries require an enforceable native memory bound: Linux with util-linux prlimit, or Windows with owned Job Objects. This host's capture boundary remains unsupported.",
  limiterUnavailable:
    "Cannot establish the selected Linux resource limiter before processing capture bytes.",
} as const;

/** Own native capture admission and the exact enforced resource profile. */
export const preparePcapNativeBound = (
  environment: Readonly<Record<string, string | undefined>>,
  resources: ArtifactAnalysisResources,
) => prepareNativeToolBound(PCAP_BOUND, environment, resources);
