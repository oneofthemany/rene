import type { AndroidAnalysisPort } from "../application/android/AndroidAnalysisPort.js";
import type { OwnedMcpLauncher } from "../process/OwnedMcpTransport.js";
import { JadxProvider } from "../android/JadxProvider.js";

/** Construct one APK provider with its own queue and cleanup-failure state. */
export const createAndroidAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  launcher?: OwnedMcpLauncher,
): AndroidAnalysisPort => new JadxProvider(environment, launcher);
