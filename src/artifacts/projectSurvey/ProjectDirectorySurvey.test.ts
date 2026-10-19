import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../contracts/toolContracts.js";
import {
  surveyProjectDirectoryInputSchema,
  TOOLS_FOR_TYPE,
} from "../../domain/projectSurvey.js";
import {
  classifyProjectFile,
  surveyProjectDirectory,
} from "./ProjectDirectorySurvey.js";

const elf = (type: number) => {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(type, 16);
  return bytes;
};
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

describe("classifyProjectFile", () => {
  it("decides by content before name", () => {
    expect(classifyProjectFile("tool.py", elf(2), 64)).toEqual({
      type: "elf",
      detection: "content",
    });
    expect(classifyProjectFile("core", elf(4), 64).type).toBe("elf-core");
    expect(classifyProjectFile("app.apk", zip, 8).type).toBe("apk");
    expect(classifyProjectFile("lib.jar", zip, 8).type).toBe("jar");
    expect(classifyProjectFile("x.bin", zip, 8).type).toBe("zip");
    expect(
      classifyProjectFile(
        "m",
        Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
        8,
      ).type,
    ).toBe("wasm");
    expect(
      classifyProjectFile(
        "db",
        Buffer.from("SQLite format 3\u0000", "latin1"),
        16,
      ).type,
    ).toBe("sqlite");
  });

  it("falls back to the name, then to text or binary", () => {
    expect(classifyProjectFile("a/b.py", Buffer.from("print(1)\n"), 9)).toEqual(
      {
        type: "python-source",
        detection: "name",
      },
    );
    expect(classifyProjectFile("notes", Buffer.from("hello"), 5)).toEqual({
      type: "text",
      detection: "content",
    });
    expect(classifyProjectFile("blob", Buffer.from([1, 0, 2]), 3).type).toBe(
      "binary",
    );
    expect(classifyProjectFile("empty", Buffer.alloc(0), 0).type).toBe("empty");
  });
});

describe("TOOLS_FOR_TYPE", () => {
  it("names only tools in the catalog", () => {
    const names = new Set<string>(TOOL_CONTRACTS.map(({ name }) => name));
    const missing = Object.values(TOOLS_FOR_TYPE)
      .flat()
      .map(([tool]) => tool)
      .filter((tool) => !names.has(tool));
    expect(missing).toEqual([]);
  });
});

describe("surveyProjectDirectory", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  const tree = async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-survey-"));
    roots.push(root);
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "src", "deep", "deeper"), { recursive: true });
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "bin", "tool"), elf(2));
    await writeFile(join(root, "bin", "app.apk"), zip);
    await writeFile(join(root, "src", "main.py"), "print(1)\n");
    await writeFile(join(root, "src", "deep", "deeper", "x.py"), "x = 1\n");
    await writeFile(join(root, ".git", "HEAD"), "ref: main\n");
    await symlink(join(root, "bin"), join(root, "loop"));
    return root;
  };
  const input = (path: string, overrides: object = {}) =>
    surveyProjectDirectoryInputSchema.parse({ path, ...overrides });

  it("reports structure, types, tools and coverage", async () => {
    const root = await tree();
    const survey = await surveyProjectDirectory(input(root));
    expect(survey.coverage).toMatchObject({
      files: 4,
      symlinks: 1,
      excluded_folders: [".git"],
      complete: false,
      entry_limit_reached: false,
    });
    expect(survey.file_types.map(({ type, files }) => [type, files])).toEqual([
      ["python-source", 2],
      ["apk", 1],
      ["elf", 1],
    ]);
    expect(survey.structure.map(({ path, files }) => [path, files])).toEqual([
      [".", 4],
      ["bin", 2],
      ["src", 2],
      ["src/deep", 1],
    ]);
    const tools = new Map(
      survey.applicable_tools.map((tool) => [tool.tool, tool]),
    );
    expect(tools.get("inspect_android_package")?.file_types).toEqual(["apk"]);
    expect(tools.get("open_binary")?.file_types).toEqual(["apk", "elf"]);
    expect(tools.get("inspect_python_blocking_calls")?.access).toBe("path");
    // The symlink to bin/ wasn't followed, so bin's files count once.
    expect(survey.file_types.find(({ type }) => type === "elf")?.files).toBe(1);
  });

  it("stops at max_depth and the entry limit, and says so", async () => {
    const root = await tree();
    const shallow = await surveyProjectDirectory(input(root, { max_depth: 1 }));
    expect(shallow.coverage.depth_limit_folders).toEqual(["src/deep"]);
    const limited = await surveyProjectDirectory(
      input(root, { max_entries: 2 }),
    );
    expect(limited.coverage.entry_limit_reached).toBe(true);
    expect(limited.limitations.join(" ")).toContain("Coverage is partial");
  });

  it("gives the same survey for the same tree", async () => {
    const root = await tree();
    expect(await surveyProjectDirectory(input(root))).toEqual(
      await surveyProjectDirectory(input(root)),
    );
  });
});

describe("source trees", () => {
  it("calls TypeScript source and plain JavaScript by their names, not bundles", () => {
    expect(
      classifyProjectFile("src/a.ts", Buffer.from("export {}\n"), 10),
    ).toEqual({ type: "typescript-source", detection: "name" });
    expect(
      classifyProjectFile("vitest.config.mts", Buffer.from("export {}\n"), 10)
        .type,
    ).toBe("typescript-source");
    expect(classifyProjectFile("lib/x.js", Buffer.from("x()\n"), 4)).toEqual({
      type: "javascript",
      detection: "name",
    });
  });
});
