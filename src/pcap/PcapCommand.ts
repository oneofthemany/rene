import {
  runBoundedToolCommand,
  type BoundedToolCommandCleanup,
  type BoundedToolCommandLauncher,
  type BoundedToolCommandLimits,
  type BoundedToolCommandOutput,
  type BoundedToolFailures,
} from "../process/BoundedToolCommand.js";
import { pcapToolUnavailable } from "./PcapConfiguration.js";

export type PcapCommandLauncher = BoundedToolCommandLauncher;
export type PcapCommandCleanup = BoundedToolCommandCleanup;
export type PcapCommandOutput = BoundedToolCommandOutput;
export type PcapCommandLimits = BoundedToolCommandLimits;

const PCAP_FAILURES: BoundedToolFailures = {
  toolUnavailable: pcapToolUnavailable,
  label: "Packet capture tool",
  unsupportedInput:
    /not a capture file|file.*isn't a capture file|file format.*not supported/iu,
};

/** Owned process execution shared by version probes and capture reads. */
export const runPcapCommand = (
  options: Omit<Parameters<typeof runBoundedToolCommand>[0], "failures">,
): Promise<PcapCommandOutput> =>
  runBoundedToolCommand({ ...options, failures: PCAP_FAILURES });
