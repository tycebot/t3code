// @effect-diagnostics nodeBuiltinImport:off - fixture scripts are written with node fs at module load.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TtsService from "./TtsService.ts";

const fixtureDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-tts-test-"));
const counterFile = NodePath.join(fixtureDir, "invocations");
const stdinEchoFile = NodePath.join(fixtureDir, "stdin.txt");
const argvFile = NodePath.join(fixtureDir, "argv.txt");
const okScript = NodePath.join(fixtureDir, "fake-tts");
const stdinScript = NodePath.join(fixtureDir, "fake-tts-stdin");
const slowScript = NodePath.join(fixtureDir, "fake-tts-slow");
const failScript = NodePath.join(fixtureDir, "fake-tts-fail");
NodeFS.writeFileSync(
  okScript,
  `#!/bin/sh\ncat > /dev/null\necho run >> ${counterFile}\nprintf 'RIFFfake-wav' > "$2"\n`,
  { mode: 0o755 },
);
NodeFS.writeFileSync(
  stdinScript,
  `#!/bin/sh\necho run >> ${counterFile}\nprintf '%s' "$*" > ${argvFile}\ncat > ${stdinEchoFile}\nprintf 'RIFFfake-wav' > "$2"\n`,
  { mode: 0o755 },
);
// Records start/end markers around a sleep so tests can measure how many
// syntheses overlapped, and sleeps long enough for races to materialize.
NodeFS.writeFileSync(
  slowScript,
  `#!/bin/sh\ncat > /dev/null\necho start >> ${counterFile}\nsleep 0.4\necho end >> ${counterFile}\nprintf 'RIFFfake-wav' > "$2"\n`,
  { mode: 0o755 },
);
NodeFS.writeFileSync(
  failScript,
  "#!/bin/sh\ncat > /dev/null\necho 'engine exploded' >&2\nexit 3\n",
  { mode: 0o755 },
);

// TtsService reads T3_TTS_COMMAND through Config when its layer builds, so each
// test gets a fresh layer with its own ConfigProvider — Config lookups are
// cached process-wide, so mutating process.env after the first read would stick.
const layerTest = (command: string) => {
  const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-tts-test-",
  });
  const platform = Layer.mergeAll(
    NodeHttpPlatform.layer,
    NodeServices.layer,
    NodeCrypto.layer,
    // mergeAll does not satisfy sibling inputs, so resolve the spawner first.
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3_TTS_COMMAND: command } })),
  );
  const signerLayer = AssetSigner.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provideMerge(layerConfig))),
    Layer.provide(platform),
  );
  return TtsService.layer.pipe(
    Layer.provide(signerLayer),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(platform),
  );
};

const counterLines = () => {
  try {
    return NodeFS.readFileSync(counterFile, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
};

const cacheDirOf = (attachmentsDir: string) =>
  NodePath.join(NodePath.dirname(attachmentsDir), "tts-cache");

describe("TtsService", () => {
  it.effect("synthesizes through the command and serves cached audio on repeat", () =>
    Effect.gen(function* () {
      const tts = yield* TtsService.TtsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.rmSync(counterFile, { force: true });

      const first = yield* tts.synthesize("  read me please  ");
      expect(first.cached).toBe(false);
      expect(first.url.startsWith(`${ASSET_ROUTE_PREFIX}/`)).toBe(true);
      expect(first.url.endsWith("/speech.wav")).toBe(true);

      const hash = TtsService.cacheKeyFor("read me please");
      const stored = NodePath.join(cacheDirOf(config.attachmentsDir), `${hash}.wav`);
      expect(yield* fileSystem.exists(stored)).toBe(true);
      expect(counterLines().filter((line) => line === "run")).toHaveLength(1);

      // Whitespace-normalized identical text hits the cache untouched.
      const second = yield* tts.synthesize("read me please");
      expect(second.cached).toBe(true);
      expect(second.url).toBe(first.url);
      expect(counterLines().filter((line) => line === "run")).toHaveLength(1);
    }).pipe(Effect.provide(layerTest(okScript))),
  );

  it.effect("delivers message text over stdin and never through argv", () =>
    Effect.gen(function* () {
      const tts = yield* TtsService.TtsService;
      NodeFS.rmSync(stdinEchoFile, { force: true });
      NodeFS.rmSync(argvFile, { force: true });

      const secret = "top secret message text";
      yield* tts.synthesize(`\n  ${secret}  \n`);

      expect(NodeFS.readFileSync(stdinEchoFile, "utf8")).toBe(secret);
      expect(NodeFS.readFileSync(argvFile, "utf8")).not.toContain(secret);
    }).pipe(Effect.provide(layerTest(stdinScript))),
  );

  it.effect("shares one in-flight synthesis between concurrent identical requests", () =>
    Effect.gen(function* () {
      const tts = yield* TtsService.TtsService;
      NodeFS.rmSync(counterFile, { force: true });

      const results = yield* Effect.all(
        [tts.synthesize("same words"), tts.synthesize(" same words ")],
        { concurrency: 2 },
      );
      expect(results[0]?.url).toBe(results[1]?.url);
      expect(counterLines()).toEqual(["start", "end"]);
    }).pipe(Effect.provide(layerTest(slowScript))),
  );

  it.effect("never runs two syntheses at once for different texts", () =>
    Effect.gen(function* () {
      const tts = yield* TtsService.TtsService;
      NodeFS.rmSync(counterFile, { force: true });

      yield* Effect.all([tts.synthesize("first text"), tts.synthesize("second text")], {
        concurrency: 2,
      });

      // With the engine limited to one process, every start must be followed
      // by its end before the next start appears.
      const lines = counterLines();
      expect(lines).toHaveLength(4);
      for (let i = 0; i < lines.length; i += 2) {
        expect(lines[i]).toBe("start");
        expect(lines[i + 1]).toBe("end");
      }
    }).pipe(Effect.provide(layerTest(slowScript))),
  );

  it.effect("removes stale partial files but keeps fresh ones", () =>
    Effect.gen(function* () {
      // Fixed epoch keeps the fixtures and the service clock on one timeline.
      const epochSeconds = 1_600_000_000;
      yield* TestClock.setTime(epochSeconds * 1000);
      const config = yield* ServerConfig.ServerConfig;
      const cacheDir = cacheDirOf(config.attachmentsDir);
      NodeFS.mkdirSync(cacheDir, { recursive: true });
      const stale = NodePath.join(cacheDir, "stalehash.deadbeef.partial");
      const fresh = NodePath.join(cacheDir, "freshhash.cafebabe.partial");
      NodeFS.writeFileSync(stale, "x");
      NodeFS.writeFileSync(fresh, "x");
      NodeFS.utimesSync(fresh, epochSeconds, epochSeconds);
      NodeFS.utimesSync(stale, epochSeconds - 2 * 60 * 60, epochSeconds - 2 * 60 * 60);

      // A synthesis triggers the retention sweep afterwards.
      const tts = yield* TtsService.TtsService;
      yield* tts.synthesize("sweep probe text");

      expect(NodeFS.existsSync(stale)).toBe(false);
      expect(NodeFS.existsSync(fresh)).toBe(true);
    }).pipe(Effect.provide(layerTest(okScript))),
  );

  it.effect("evicts least recently used audio over the cache bound", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const cacheDir = cacheDirOf(config.attachmentsDir);
      NodeFS.mkdirSync(cacheDir, { recursive: true });
      const base = 1_500_000_000;
      for (let i = 0; i < 205; i++) {
        const name = `fill${String(i).padStart(4, "0")}.wav`;
        NodeFS.writeFileSync(NodePath.join(cacheDir, name), "x");
        NodeFS.utimesSync(NodePath.join(cacheDir, name), base + i, base + i);
      }

      const tts = yield* TtsService.TtsService;
      yield* tts.synthesize("eviction probe text");

      const remaining = NodeFS.readdirSync(cacheDir).filter((name) => name.endsWith(".wav"));
      expect(remaining.length).toBeLessThanOrEqual(200);
      // Newest entries survive, oldest are evicted.
      expect(remaining).toContain("fill0204.wav");
      expect(remaining).not.toContain("fill0000.wav");
    }).pipe(Effect.provide(layerTest(okScript))),
  );

  it.effect("fails with TtsUnavailableError when the command exits non-zero", () =>
    Effect.gen(function* () {
      const tts = yield* TtsService.TtsService;
      const failure = yield* tts.synthesize("anything").pipe(Effect.flip);
      expect(failure.reason).toContain("engine exploded");
    }).pipe(Effect.provide(layerTest(failScript))),
  );

  it.effect("rejects blank text without invoking the command", () =>
    Effect.gen(function* () {
      const tts = yield* TtsService.TtsService;
      NodeFS.rmSync(counterFile, { force: true });
      const failure = yield* tts.synthesize("   \n ").pipe(Effect.flip);
      expect(failure.reason).toBe("message is empty");
      expect(counterLines()).toHaveLength(0);
    }).pipe(Effect.provide(layerTest(okScript))),
  );
});
