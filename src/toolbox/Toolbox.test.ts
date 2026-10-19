import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  editFileInputSchema,
  findFilesInputSchema,
  readFileInputSchema,
  runCommandInputSchema,
  searchTextInputSchema,
  writeFileInputSchema,
} from "../domain/toolbox.js";
import { runToolboxCommand } from "./ToolboxCommand.js";
import {
  confine,
  editTextFile,
  findFiles,
  readTextFile,
  searchText,
  toolboxRoots,
  writeTextFile,
} from "./ToolboxFiles.js";

let base: string;
let root: string;
let outside: string;
let roots: string[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "rea-toolbox-"));
  root = join(base, "home");
  outside = join(base, "outside");
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(outside);
  await writeFile(
    join(root, "src", "a.ts"),
    "const a = 1;\nopenDatabase();\nconst b = 2;\n",
  );
  await writeFile(join(root, "src", "deep", "b.ts"), "openDatabase(x);\n");
  await writeFile(join(root, "src", "notes.md"), "OpenDatabase in docs\n");
  await writeFile(
    join(root, "node_modules", "pkg", "c.ts"),
    "openDatabase();\n",
  );
  await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2, 3]));
  await writeFile(join(outside, "secret.txt"), "outside\n");
  await symlink(outside, join(root, "escape"));
  roots = await toolboxRoots({ REA_TOOLBOX_ROOTS: root });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("confine", () => {
  it("refuses paths outside the roots, including through symlinks", async () => {
    await expect(
      confine(roots, join(outside, "secret.txt"), "path"),
    ).rejects.toThrow(/outside the toolbox roots/);
    await expect(
      confine(roots, join(root, "escape", "secret.txt"), "path"),
    ).rejects.toThrow(/outside/);
    await expect(
      confine(roots, join(root, "escape", "new.txt"), "path"),
    ).rejects.toThrow(/outside/);
    await expect(confine(roots, "relative/path", "path")).rejects.toThrow(
      /absolute/,
    );
    expect(
      await confine(roots, join(root, "src", "new", "file.ts"), "path"),
    ).toBe(join(roots[0]!, "src", "new", "file.ts"));
  });
});

describe("files", () => {
  it("reads a line range, and reports binary files without text", async () => {
    const read = await readTextFile(
      roots,
      readFileInputSchema.parse({
        path: join(root, "src", "a.ts"),
        start_line: 2,
        max_lines: 1,
      }),
    );
    expect(read).toMatchObject({
      text: "openDatabase();",
      start_line: 2,
      end_line: 2,
      total_lines: 4,
      truncated: true,
      binary: false,
    });
    const binary = await readTextFile(
      roots,
      readFileInputSchema.parse({ path: join(root, "blob.bin") }),
    );
    expect(binary).toMatchObject({ binary: true, text: "", bytes: 4 });
  });

  it("writes atomically, refusing to overwrite or create folders unless asked", async () => {
    const path = join(root, "src", "a.ts");
    await chmod(path, 0o640);
    await expect(
      writeTextFile(roots, writeFileInputSchema.parse({ path, content: "x" })),
    ).rejects.toThrow(/overwrite/);
    const written = await writeTextFile(
      roots,
      writeFileInputSchema.parse({ path, content: "new\n", overwrite: true }),
    );
    expect(written).toMatchObject({ created: false, bytes: 4 });
    expect(written.previous_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(path, "utf8")).toBe("new\n");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    const nested = join(root, "made", "here.txt");
    await expect(
      writeTextFile(
        roots,
        writeFileInputSchema.parse({ path: nested, content: "x" }),
      ),
    ).rejects.toThrow(/create_directories/);
    expect(
      await writeTextFile(
        roots,
        writeFileInputSchema.parse({
          path: nested,
          content: "x",
          create_directories: true,
        }),
      ),
    ).toMatchObject({ created: true, previous_sha256: null });
  });

  it("edits exactly one occurrence unless replace_all is set", async () => {
    const path = join(root, "src", "a.ts");
    await expect(
      editTextFile(
        roots,
        editFileInputSchema.parse({ path, old_text: "const", new_text: "let" }),
      ),
    ).rejects.toThrow(/occurs 2 times/);
    await expect(
      editTextFile(
        roots,
        editFileInputSchema.parse({ path, old_text: "missing", new_text: "x" }),
      ),
    ).rejects.toThrow(/doesn't occur/);
    expect(
      await editTextFile(
        roots,
        editFileInputSchema.parse({
          path,
          old_text: "const a",
          new_text: "let a",
        }),
      ),
    ).toMatchObject({ replacements: 1 });
    expect(
      await editTextFile(
        roots,
        editFileInputSchema.parse({
          path,
          old_text: "Database",
          new_text: "Store",
          replace_all: true,
        }),
      ),
    ).toMatchObject({ replacements: 1 });
    expect(await readFile(path, "utf8")).toBe(
      "let a = 1;\nopenStore();\nconst b = 2;\n",
    );
  });
});

describe("find and search", () => {
  it("finds files by glob, skipping excluded folders and not following symlinks", async () => {
    const found = await findFiles(
      roots,
      findFilesInputSchema.parse({ root, pattern: "**/*.ts" }),
    );
    expect(found.matches.map((match) => match.path)).toEqual([
      "src/a.ts",
      "src/deep/b.ts",
    ]);
    expect(found.excluded_folders).toEqual(["node_modules"]);
    const all = await findFiles(
      roots,
      findFilesInputSchema.parse({ root, pattern: "*" }),
    );
    expect(all.matches.find((match) => match.path === "escape")?.kind).toBe(
      "symlink",
    );
  });

  it("searches literally or by regex, with context, skipping binary files", async () => {
    const literal = await searchText(
      roots,
      searchTextInputSchema.parse({
        root,
        query: "openDatabase(",
        context_lines: 1,
      }),
    );
    expect(
      literal.matches.map((match) => `${match.path}:${match.line}`),
    ).toEqual(["src/a.ts:2", "src/deep/b.ts:1"]);
    expect(literal.matches[0]).toMatchObject({
      column: 1,
      before: [{ line: 1, text: "const a = 1;" }],
      after: [{ line: 3, text: "const b = 2;" }],
    });
    expect(literal.skipped_binary).toBe(1);
    const regex = await searchText(
      roots,
      searchTextInputSchema.parse({
        root,
        query: "opendatabase\\(\\w+\\)",
        regex: true,
        case_sensitive: false,
      }),
    );
    expect(regex.matches.map((match) => match.path)).toEqual(["src/deep/b.ts"]);
    await expect(
      searchText(
        roots,
        searchTextInputSchema.parse({ root, query: "(", regex: true }),
      ),
    ).rejects.toThrow(/regular expression/);
  });
});

describe("run_command", () => {
  const retained: unknown[] = [];
  const options = {
    environment: process.env,
    retain: (owner: unknown) => retained.push(owner),
  };

  it("returns output and a nonzero exit as a result, in a confined folder", async () => {
    const result = await runToolboxCommand(
      roots,
      runCommandInputSchema.parse({
        command: "pwd; echo err >&2; exit 3",
        cwd: join(root, "src"),
      }),
      options,
    );
    expect(result).toMatchObject({
      exit_code: 3,
      stopped: null,
      stderr: "err\n",
    });
    expect(result.stdout.trim()).toBe(join(roots[0]!, "src"));
    await expect(
      runToolboxCommand(
        roots,
        runCommandInputSchema.parse({ command: "true", cwd: outside }),
        options,
      ),
    ).rejects.toThrow(/outside/);
  });

  it("stops a command at its timeout", async () => {
    const result = await runToolboxCommand(
      roots,
      runCommandInputSchema.parse({
        command: "echo started; sleep 30",
        cwd: root,
        timeout_ms: 500,
      }),
      options,
    );
    expect(result.stopped).toBe("timeout");
    expect(result.duration_ms).toBeLessThan(10_000);
    expect(retained).toEqual([]);
  });
});
