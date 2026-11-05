// Synthesizes speech for the read-aloud button using the host's local `tts`
// CLI (see ~/Projects/tts-lab on the reference machine). Synthesized wav files
// are cached under the server state directory and served through signed asset
// URLs, so playback works from any surface — web, desktop, phone — including
// remote sessions where the browser cannot attach auth headers to <audio>.
//
// One speech engine runs per host, so synthesis is serialized behind a
// semaphore (a flood of clicks must not stack processes and starve the
// environment's real work), identical texts share a single in-flight run, and
// the cache is pruned to bounded entries (write-time LRU) with stale partial
// files removed.
// Message text travels to the CLI over stdin, never argv, so it cannot appear
// in process listings.
// @effect-diagnostics nodeBuiltinImport:off — hashing and tmp names are plain
// module-scope helpers, mirroring attachmentStore.ts; no Effect runtime touches node:crypto.
import * as NodeCrypto from "node:crypto";

import { TtsUnavailableError, type TtsSynthesizeResult } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as AssetAccess from "../assets/AssetAccess.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

// Long enough for any realistic assistant message, short enough that a
// misfired request cannot pin the speech engine for minutes.
const SYNTHESIS_TIMEOUT_MS = 120_000;
// How long a request may wait behind the engine queue before giving up.
const DEFAULT_QUEUE_TIMEOUT_MS = 45_000;
// Cache bounds: assistant messages are small wavs, so entry count is the
// practical limit; bytes are the backstop for pathological long-form audio.
const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
// A `.partial` older than this belongs to a crashed synthesis, not a running one.
const PARTIAL_MAX_AGE_MS = 30 * 60 * 1000;
const STDERR_DETAIL_LIMIT = 400;

const TTS_COMMAND_ENV = "T3_TTS_COMMAND";
const TTS_QUEUE_TIMEOUT_ENV = "T3_TTS_QUEUE_TIMEOUT_MS";

export type TtsSynthesized = TtsSynthesizeResult;

export interface TtsService {
  readonly synthesize: (text: string) => Effect.Effect<TtsSynthesized, TtsUnavailableError>;
}

export const TtsService = Context.Service<TtsService>("@t3tools/server/tts/TtsService");

// Exported so cache eviction tooling and tests derive the same keys.
export const cacheKeyFor = (text: string) =>
  NodeCrypto.createHash("sha256").update(`v1\n${text}`).digest("hex").slice(0, 40);

const tmpPartNameFor = (hash: string) => `${hash}.${NodeCrypto.randomUUID()}.partial`;
const isPartialName = (name: string) => name.endsWith(".partial");

const trimDetail = (value: string) =>
  value.trim().slice(0, STDERR_DETAIL_LIMIT) || "the speech command produced no output";

type SynthesisDeferred = Deferred.Deferred<TtsSynthesized, TtsUnavailableError>;

export const layer = Layer.effect(
  TtsService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const command = yield* Config.String(TTS_COMMAND_ENV).pipe(Config.withDefault("tts"));
    const queueTimeoutMs = yield* Config.Number(TTS_QUEUE_TIMEOUT_ENV).pipe(
      Config.withDefault(DEFAULT_QUEUE_TIMEOUT_MS),
    );
    // Acquire request-scoped services once so `synthesize` needs nothing from its caller.
    const assetSigner = yield* AssetSigner.AssetSigner;
    // Sits beside the attachments directory so it follows the same state-dir
    // relocation as the rest of the server's durable files.
    const cacheDir = path.join(path.dirname(config.attachmentsDir), "tts-cache");

    // The speech engine is a single shared resource (often a warm local model
    // on the same box as the agent), so at most one synthesis runs at a time.
    const engineLimit = Semaphore.makeUnsafe(1);
    // Waiters for the exact same text share the running synthesis instead of
    // queueing a duplicate behind it.
    const inFlight = new Map<string, SynthesisDeferred>();

    const lockCacheDir = Effect.gen(function* () {
      yield* fileSystem
        .makeDirectory(cacheDir, { recursive: true })
        .pipe(
          Effect.mapError(() => new TtsUnavailableError({ reason: `cannot create ${cacheDir}` })),
        );
      // Audio replays assistant text; keep it out of other users' hands on
      // shared machines. Best-effort: some filesystems reject chmod.
      yield* fileSystem.chmod(cacheDir, 0o700).pipe(Effect.ignore);
    });

    const speak = Effect.fnUntraced(function* (text: string, tmpPath: string) {
      const result = yield* processRunner
        .run({
          command,
          // Text goes through stdin: argv would expose message contents in
          // process listings and choke on very long replies.
          args: ["--save", tmpPath, "--no-play"],
          stdin: text,
          timeout: SYNTHESIS_TIMEOUT_MS,
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
          truncatedMarker: "",
        })
        .pipe(
          Effect.mapError(
            (failure) =>
              new TtsUnavailableError({
                reason: trimDetail(`${failure._tag}: ${failure.message}`),
              }),
          ),
        );
      if (result.timedOut) {
        return yield* new TtsUnavailableError({ reason: "synthesis timed out" });
      }
      if (result.code !== 0) {
        return yield* new TtsUnavailableError({
          reason: trimDetail(result.stderr || `exit code ${result.code ?? "killed"}`),
        });
      }
      return result.stderr;
    });

    // At startup every partial is garbage (nothing can be mid-flight). Later
    // sweeps drop a partial once the Effect clock passes its mtime by more
    // than the window, so tests drive staleness with TestClock. Eviction is
    // write-time LRU: newest entries are kept.
    const pruneCache = Effect.fn("TtsService.pruneCache")(function* (options: {
      readonly startup: boolean;
    }) {
      const entries = yield* fileSystem
        .readDirectory(cacheDir)
        .pipe(Effect.orElseSucceed(() => []));
      const now = options.startup ? 0 : yield* Clock.currentTimeMillis;
      const wavs: Array<{ name: string; mtimeMs: number; size: number }> = [];
      for (const name of entries) {
        const info = yield* fileSystem
          .stat(path.join(cacheDir, name))
          .pipe(Effect.orElseSucceed(() => null));
        if (info === null) continue;
        const mtimeMs = Option.getOrElse(
          Option.map(info.mtime, (mtime) => mtime.getTime()),
          () => 0,
        );
        if (isPartialName(name)) {
          if (options.startup || now - mtimeMs > PARTIAL_MAX_AGE_MS) {
            yield* fileSystem
              .remove(path.join(cacheDir, name), { force: true })
              .pipe(Effect.ignore);
          }
          continue;
        }
        if (name.endsWith(".wav")) {
          wavs.push({ name, mtimeMs, size: Number(info.size) });
        }
      }
      wavs.sort((a, b) => b.mtimeMs - a.mtimeMs);
      let bytes = 0;
      for (const [index, wav] of wavs.entries()) {
        bytes += wav.size;
        if (index < CACHE_MAX_ENTRIES && bytes <= CACHE_MAX_TOTAL_BYTES) continue;
        yield* fileSystem
          .remove(path.join(cacheDir, wav.name), { force: true })
          .pipe(Effect.ignore);
      }
    });

    const synthesizeUncached = Effect.fnUntraced(function* (hash: string, text: string) {
      const audioPath = path.join(cacheDir, `${hash}.wav`);
      const tmpPath = path.join(cacheDir, tmpPartNameFor(hash));
      yield* lockCacheDir;

      // The queue wait is bounded too: a wedged engine must fail requests
      // fast rather than piling them up for minutes.
      const stderr = yield* engineLimit.withPermit(speak(text, tmpPath)).pipe(
        Effect.timeoutOrElse({
          duration: queueTimeoutMs,
          orElse: () =>
            new TtsUnavailableError({
              reason: "the speech engine is busy with other requests",
            }),
        }),
      );

      const produced = yield* fileSystem.exists(tmpPath).pipe(Effect.orElseSucceed(() => false));
      if (!produced) {
        return yield* new TtsUnavailableError({
          reason: trimDetail(stderr || "the speech command produced no audio file"),
        });
      }

      const stored = yield* fileSystem.rename(tmpPath, audioPath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!stored) {
        // Lost the rename race or hit a filesystem quirk: another writer may
        // already own the file, so accept only a confirmed audio path.
        const recovered = yield* fileSystem
          .exists(audioPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!recovered) {
          return yield* new TtsUnavailableError({ reason: "could not store synthesized audio" });
        }
      }
      yield* fileSystem.chmod(audioPath, 0o600).pipe(Effect.ignore);
      // Retention is enforced whenever new bytes land; synthesis is seconds
      // long, so this sweep is noise next to the engine work.
      yield* pruneCache({ startup: false });
      return audioPath;
    });

    const synthesize = Effect.fn("TtsService.synthesize")(function* (rawText: string) {
      const text = rawText.trim();
      if (text.length === 0) {
        return yield* new TtsUnavailableError({ reason: "message is empty" });
      }
      const hash = cacheKeyFor(text);
      const audioPath = path.join(cacheDir, `${hash}.wav`);

      // Claim the hash synchronously (no yield between check and set) so two
      // requests racing in from the socket cannot both start a synthesis.
      const existing = inFlight.get(hash);
      if (existing !== undefined) {
        return yield* Deferred.await(existing);
      }
      const deferred = Deferred.makeUnsafe<TtsSynthesized, TtsUnavailableError>();
      inFlight.set(hash, deferred);

      return yield* Effect.gen(function* () {
        const cachedAt = yield* fileSystem
          .exists(audioPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (cachedAt) {
          return yield* issueSigned(audioPath, true);
        }
        const stored = yield* synthesizeUncached(hash, text);
        return yield* issueSigned(stored, false);
      }).pipe(
        // Waiters registered before this fiber's work started share its fate.
        Effect.tap((value) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(deferred, Effect.succeed(value));
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(deferred, Effect.fail(error));
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (inFlight.get(hash) === deferred) inFlight.delete(hash);
            // An interrupted creator must not strand its waiters.
            if (!Deferred.isDoneUnsafe(deferred)) Deferred.doneUnsafe(deferred, Effect.interrupt);
          }),
        ),
      );
    });

    const issueSigned = (filePath: string, cached: boolean) =>
      AssetAccess.issueTtsAudioUrl({ filePath, fileName: "speech.wav" }).pipe(
        Effect.provideService(AssetSigner.AssetSigner, assetSigner),
        Effect.map(
          (asset) =>
            ({
              url: asset.relativeUrl,
              cached,
              expiresAt: asset.expiresAt,
            }) satisfies TtsSynthesized,
        ),
      );

    // Clear crash leftovers from previous server runs before serving requests.
    yield* lockCacheDir;
    yield* pruneCache({ startup: true });

    return { synthesize } satisfies TtsService;
  }),
);
