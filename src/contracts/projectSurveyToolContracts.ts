import {
  projectSurveySchema,
  surveyProjectDirectoryInputSchema,
} from "../domain/projectSurvey.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** What a project directory holds and which REA tools apply to it. */
export const PROJECT_SURVEY_TOOL_CONTRACTS = [
  {
    name: "survey_project_directory",
    ...toolContractMetadata("survey_project_directory"),
    kind: "artifact-provider",
    description:
      "Survey an explicit local project directory: its folder structure (to depth 2, with file counts, bytes and main file types per folder), the file types in use, and the REA tools that accept those types, with example paths. File types come from content signatures where a format has one (ELF and core dumps, PE, Mach-O, ZIP and the APK/IPA/JAR/HAP packages, ASAR, plist, WASM, SQLite, DuckDB, pcap/pcapng, DEX, squashfs and more) and from names only otherwise; each type says which. Reads at most 4 KiB of each file, never follows symbolic links, and is read-only: it writes nothing and invokes no other program. Folders named in exclude_names (default .git and node_modules), folders past max_depth, unreadable entries and the entry limit are reported in coverage; types in folders that weren't walked are unknown, not absent. Use it first in a new project to choose tools.",
    inputSchema: surveyProjectDirectoryInputSchema,
    outputSchema: evidenceResultOf(projectSurveySchema),
    examples: [
      {
        title: "Survey a project directory",
        input: { path: "/home/analyst/projects/target" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
