import { readdir, readFile } from "node:fs/promises";

/**
 * The resources one process group used, read from the kernel's per-process
 * accounting in /proc while it runs: its peak resident memory, summed over
 * every process in the group at each sample, and the CPU time of each
 * process the samples saw. A container's cgroup can't be split per command
 * (it is read-only and covers the whole container), so this samples; a
 * process that lives less than one interval may be missed, and the method
 * says so.
 */
export interface ProcessGroupUsage {
  readonly peak_rss_bytes: number;
  readonly cpu_user_ms: number;
  readonly cpu_system_ms: number;
  readonly processes_seen: number;
  readonly samples: number;
  readonly interval_ms: number;
  readonly method: string;
}

const PAGE_BYTES = 4096;
/** USER_HZ: Linux reports utime and stime in 1/100 s on every platform it runs on. */
const CLOCK_TICKS_PER_SECOND = 100;

interface ProcessSample {
  readonly processGroup: number;
  readonly userTicks: number;
  readonly systemTicks: number;
  readonly rssBytes: number;
}

/** One process's /proc/<pid>/stat, or undefined when it has gone. */
const readProcess = async (pid: string): Promise<ProcessSample | undefined> => {
  let text: string;
  try {
    text = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // The command name, field 2, is in parentheses and may contain spaces.
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  // Counting from field 3 (state): pgrp is 5, utime 14, stime 15, rss 24.
  const field = (n: number) => Number(fields[n - 3]);
  return {
    processGroup: field(5),
    userTicks: field(14),
    systemTicks: field(15),
    rssBytes: field(24) * PAGE_BYTES,
  };
};

/**
 * Starts sampling process group `processGroup` every `intervalMs`; `stop`
 * takes a last sample and returns the usage, or undefined where /proc isn't
 * available (anywhere but Linux).
 */
export const sampleProcessGroup = (
  processGroup: number,
  intervalMs = 50,
): { stop(): Promise<ProcessGroupUsage | undefined> } => {
  const cpu = new Map<string, { user: number; system: number }>();
  let peak = 0;
  let samples = 0;
  let available = process.platform === "linux";
  let running: Promise<void> | undefined;

  const sample = async (): Promise<void> => {
    let pids: string[];
    try {
      pids = (await readdir("/proc")).filter((name) => /^\d+$/u.test(name));
    } catch {
      available = false;
      return;
    }
    let rss = 0;
    for (const pid of pids) {
      const observed = await readProcess(pid);
      if (observed === undefined || observed.processGroup !== processGroup)
        continue;
      rss += observed.rssBytes;
      // CPU time only grows; the last value seen is the process's total so far.
      cpu.set(pid, {
        user: observed.userTicks,
        system: observed.systemTicks,
      });
    }
    peak = Math.max(peak, rss);
    samples += 1;
  };
  const tick = () => {
    running ??= sample().finally(() => (running = undefined));
  };
  if (available) tick();
  const timer = available ? setInterval(tick, intervalMs) : undefined;
  timer?.unref();

  return {
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      await running;
      if (available) await sample();
      if (!available) return undefined;
      const total = (key: "user" | "system") =>
        Math.round(
          ([...cpu.values()].reduce((sum, ticks) => sum + ticks[key], 0) *
            1000) /
            CLOCK_TICKS_PER_SECOND,
        );
      return {
        peak_rss_bytes: peak,
        cpu_user_ms: total("user"),
        cpu_system_ms: total("system"),
        processes_seen: cpu.size,
        samples,
        interval_ms: intervalMs,
        method: `Sampled /proc every ${intervalMs} ms: peak is the most resident memory the command's process group held at one sample, summed over its processes; CPU is each process's time at its last sample. A process that lives less than one interval may be missed.`,
      };
    },
  };
};
