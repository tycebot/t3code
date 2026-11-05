// @effect-diagnostics nodeBuiltinImport:off - fixture scripts are written with node fs at module load.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import * as TtsService from "./TtsService.ts";

const fixtureDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-tts-test-"));
const counterFile = NodePath.join(fixtureDir, "invocations");
const okScript = NodePath.join(fixtureDir, "fake-tts");
const failScript = NodePath.join(fixtureDir, "fake-tts-fail");
NodeFS.writeFileSync(
  okScript,
  `#!/bin/sh\necho run >> ${counterFile}\nprintf 'RIFFfake-wav' > "$2"\n`,
  { mode: 0o755 },
);
NodeFS.writeFileSync(failScript, "#!/bin/sh\necho 'engine exploded' >&2\nexit 3\n", {
  mode: 0o755,
});

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

const invocations = () => NodeFS.readFileSync(counterFile, "utf8").trim().split("\n").length;

describe("TtsService", () => {
  it.effect("synthesizes through the command and serves cached audio on repeat", () =>
    Effect.gen(function* () {
      const tts = yield* TtsService.TtsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.rmSync(counterFile, { force: true });

      const first = yield* tts.synthesize("  read me please  ");
      expect(first.cached).toBe(false);
      expect(first.url.startsWith(`${ASSET_ROUTE_PREFIX}/`)).toBe(true);
      expect(first.url.endsWith("/speech.wav")).toBe(true);

      const hash = TtsService.cacheKeyFor("read me please");
      const stored = path.join(
        path.join(path.dirname(config.attachmentsDir), "tts-cache"),
        `${hash}.wav`,
      );
      expect(yield* fileSystem.exists(stored)).toBe(true);
      expect(invocations()).toBe(1);

      // Whitespace-normalized identical text hits the cache untouched.
      const second = yield* tts.synthesize("read me please");
      expect(second.cached).toBe(true);
      expect(second.url).toBe(first.url);
      expect(invocations()).toBe(1);
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
      const failure = yield* tts.synthesize("   \n ").pipe(Effect.flip);
      expect(failure.reason).toBe("message is empty");
    }).pipe(Effect.provide(layerTest(okScript))),
  );
});
