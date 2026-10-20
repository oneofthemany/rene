import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { WASM_RUNTIME_FLAGS } from './src/extraction/wasm-runtime-flags';

/**
 * Two projects, one command (`npm test` still runs everything).
 *
 * The split exists because of exactly one suite. `ui-package.test.ts` mounts
 * `@colbymchenry/codegraph-ui`'s components against a mock adapter (task
 * CG-61), and to do that it needs three things the engine's suites must never
 * see:
 *
 *   - the **Svelte plugin**, to compile `.svelte` and `.svelte.ts` modules;
 *   - **jsdom**, because a component without a document is not a render;
 *   - `resolve.conditions: ['browser']`, so `svelte` resolves to its client
 *     build rather than its server one (`mount()` throws on the server).
 *
 * That last one is why these are projects rather than one config with a
 * couple of extra fields. `browser` is a package-resolution condition, not a
 * test setting: applied globally it would also hand the engine's suites the
 * browser builds of `web-tree-sitter` and friends, and the failures that
 * causes look nothing like their cause.
 *
 * Neither project `extends: true`: a project CONCATENATES the root's `include`
 * with its own, so the ui project would run all 200-odd engine suites a second
 * time inside jsdom. Each project carries its own settings instead.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    projects: [
      {
        test: {
          name: 'engine',
          globals: true,
          environment: 'node',
          include: ['__tests__/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '__tests__/ui-package.test.ts'],
          // Suites that spawn the built CLI need a current dist/ (#1879), and the end
          // of the run removes any home sandbox its own test file could not.
          globalSetup: ['./__tests__/global-setup-dist.ts', './__tests__/global-setup-home-sandbox.ts'],
          // A throwaway home dir (and git global config) per test file, so nothing
          // the suite runs can write to the developer's real one (#2275).
          setupFiles: ['./__tests__/setup-home-sandbox.ts'],
          /**
           * Several MCP integration tests (mcp-daemon, mcp-initialize, mcp-ppid-watchdog,
           * mcp-roots) spawn `dist/bin/codegraph.js serve --mcp` with `process.execPath`
           * and rely on the child inheriting `process.env`. On a Node >= 25 dev machine
           * the CLI's hard-block (src/bin/codegraph.ts) would otherwise exit the child
           * before it ever responds, so every spawn-based test times out — see #478.
           *
           * Setting the override here keeps the CLI's runtime guard intact for end
           * users (it's still enforced when `codegraph` is invoked directly) while
           * letting the test suite run on whatever Node the contributor happens to
           * have installed. CI on Node 22/23 is unaffected — the guard doesn't fire
           * there, so the variable is a no-op.
           */
          env: {
            CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
            /**
             * The suite spawns real CLI/MCP processes; without this they would write
             * telemetry state into the contributor's real ~/.codegraph and count test
             * tool calls as real usage. The telemetry unit tests are unaffected —
             * they inject their own `env` via the Telemetry constructor.
             */
            CODEGRAPH_TELEMETRY: '0',
          },
          /**
           * The same V8 flags every real launch path passes (the bundled launcher,
           * the CLI's self re-exec, refresh-launcher): keep tree-sitter grammar
           * compilation on the Liftoff baseline tier. Without them a pool worker
           * runs the grammars on the turboshaft optimizing tier, and once enough
           * parses have warmed a grammar function up, its background tier-up job
           * exhausts a compiler Zone and aborts the worker — `Fatal process out of
           * memory: Zone`, surfaced by vitest only as "Worker exited unexpectedly"
           * with the rest of the file's tests silently unrun (#1779; the product-side
           * story is in wasm-runtime-flags.ts, #293/#298). On Node 24 with a
           * 660-test extraction suite this reproduced on every run at the same test.
           * V8 flags are process-global, so the parse worker threads a test spawns
           * are covered too.
           */
          pool: 'forks',
          execArgv: [...WASM_RUNTIME_FLAGS],
        },
      },
      {
        plugins: [
          // The same preprocessor `ui/svelte.config.js` builds with, so the test
          // compiles what the package ships.
          svelte({ preprocess: vitePreprocess() }),
        ],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'ui',
          globals: true,
          include: ['__tests__/ui-package.test.ts'],
          environment: 'jsdom',
          server: {
            deps: {
              // `@xyflow/svelte` ships uncompiled `.svelte` files, so it has to go
              // through the plugin above rather than be externalised to Node,
              // which has no idea what a `.svelte` file is.
              inline: [/@xyflow\/svelte/],
            },
          },
        },
      },
    ],
  },
});
