import type { PythonAnalysisPort } from "../application/python/PythonAnalysisPort.js";
import { PythonSourceProvider } from "../python/PythonSourceProvider.js";

/** Construct one Python source provider bound to the caller-selected interpreter. */
export const createPythonAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PythonAnalysisPort => new PythonSourceProvider({ environment });
