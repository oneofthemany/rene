import { mkdir } from "node:fs/promises";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  OwnedFileSnapshot,
  type OwnedFileIdentity,
} from "../filesystem/OwnedFileSnapshot.js";

const OPERATION = "inspect_pcap_capture";
const MAX_CAPTURE_BYTES = 2 * 1024 ** 3;
const CAPTURE = "capture.pcap";

/** An owned capture copy and every descriptor needed to release it safely. */
export class PcapSnapshot {
  readonly path: string;
  readonly configurationPath: string;
  private constructor(private readonly files: OwnedFileSnapshot) {
    this.path = files.pathOf(CAPTURE);
    this.configurationPath = files.pathOf("configuration");
  }

  static async create(): Promise<PcapSnapshot> {
    return new PcapSnapshot(
      await OwnedFileSnapshot.create({
        provider: "pcap",
        operation: OPERATION,
        prefix: "rea-pcap-",
        maxBytes: MAX_CAPTURE_BYTES,
        noun: "Capture",
        analysedNoun: "packet",
      }),
    );
  }

  async capture(
    path: string,
    signal?: AbortSignal,
  ): Promise<OwnedFileIdentity> {
    signal?.throwIfAborted();
    // Wireshark's configuration and temp files stay inside the owned root.
    await mkdir(this.configurationPath, { mode: 0o700 }).catch(
      (cause: unknown) => {
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "file-size",
          "Owned capture snapshot I/O failed",
          null,
          { cause },
        );
      },
    );
    return this.files.copy(path, CAPTURE, signal);
  }

  /** Recheck byte identity after both tools; a read-only mode alone is not proof. */
  verify(
    expected: OwnedFileIdentity,
    selectedPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.files.verify(CAPTURE, expected, selectedPath, signal);
  }

  close(): Promise<void> {
    return this.files.close();
  }
}
