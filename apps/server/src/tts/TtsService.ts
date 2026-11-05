// Synthesizes speech for the read-aloud button using the host's local `tts`
// CLI (see ~/Projects/tts-lab on the reference machine). Synthesized wav files
// are cached under the server state directory and served through signed asset
// URLs, so playback works from any surface — web, desktop, phone — including
// remote sessions where the browser cannot attach auth headers to <audio>.
// @effect-diagnostics nodeBuiltinImport:off — hashing and tmp names are plain
// module-scope helpers, mirroring attachmentStore.ts; no Effect runtime touches node:crypto.
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as AssetAccess from "../assets/AssetAccess.ts";
import * as ServerConfig from "../config.ts";

// Long enough for any realistic assistant message, short enough that a
// misfired request cannot pin the speech engine for minutes.
const SYNTHESIS_TIMEOUT_MS = 120_000;
const STDERR_DETAIL_LIMIT = 400;

const TTS_COMMAND_ENV = "T3_TTS_COMMAND";

export class TtsUnavailableError extends Schema.TaggedError<TtsUnavailableError>()(
  "TtsUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Speech synthesis is unavailable on this environment (${this.reason}).`;
  }
}

export interface TtsSynthesized {
  readonly url: string;
  readonly cached: boolean;
  readonly expiresAt: number;
}

export interface TtsService {
  readonly synthesize: (text: string) => Effect.Effect<TtsSynthesized, TtsUnavailableError>;
}

export const TtsService = Context.Service<TtsService>("@t3tools/server/tts/TtsService");

// Exported so cache eviction tooling and tests derive the same keys.
export const cacheKeyFor = (text: string) =>
  NodeCrypto.createHash("sha256").update(`v1\n${text}`).digest("hex").slice(0, 40);

const tmpPartNameFor = (hash: string) => `${hash}.${NodeCrypto.randomUUID()}.partial`;

const isTtsUnavailable = Schema.is(TtsUnavailableError);

const trimDetail = (value: string) =>
  value.trim().slice(0, STDERR_DETAIL_LIMIT) || "the speech command produced no output";

export const layer = Layer.effect(
  TtsService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const command = yield* Config.String(TTS_COMMAND_ENV).pipe(Config.withDefault("tts"));
    // Acquire request-scoped services once so `synthesize` needs nothing from its caller.
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const assetSigner = yield* AssetSigner.AssetSigner;
    // Sits beside the attachments directory so it follows the same state-dir
    // relocation as the rest of the server's durable files.
    const cacheDir = path.join(path.dirname(config.attachmentsDir), "tts-cache");

    const speak = Effect.fnUntraced(function* (text: string, tmpPath: string) {
      const run = Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, ["--save", tmpPath, "--no-play", "--", text], {
              stdin: "ignore",
            }),
          );
          const stderr = yield* child.stderr.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.orElseSucceed(() => ""),
          );
          const exitCode = yield* child.exitCode;
          return { exitCode, stderr };
        }),
      );
      return yield* run.pipe(
        Effect.catchTags({
          PlatformError: () =>
            Effect.fail(
              new TtsUnavailableError({ reason: `${command}: could not run the speech process` }),
            ),
        }),
        Effect.timeoutOrElse({
          duration: SYNTHESIS_TIMEOUT_MS,
          orElse: () => new TtsUnavailableError({ reason: "synthesis timed out" }),
        }),
        Effect.catchIf(
          (cause: unknown) => !isTtsUnavailable(cause),
          (cause: unknown) =>
            Effect.fail(
              new TtsUnavailableError({ reason: `${command}: ${trimDetail(String(cause))}` }),
            ),
        ),
      );
    });

    const synthesize = Effect.fn("TtsService.synthesize")(function* (rawText: string) {
      const text = rawText.trim();
      if (text.length === 0) {
        return yield* new TtsUnavailableError({ reason: "message is empty" });
      }

      const audioPath = path.join(cacheDir, `${cacheKeyFor(text)}.wav`);
      const cached = yield* fileSystem.exists(audioPath).pipe(Effect.orElseSucceed(() => false));

      if (!cached) {
        const tmpPath = path.join(cacheDir, tmpPartNameFor(cacheKeyFor(text)));
        yield* fileSystem
          .makeDirectory(cacheDir, { recursive: true })
          .pipe(
            Effect.mapError(() => new TtsUnavailableError({ reason: `cannot create ${cacheDir}` })),
          );

        const result = yield* speak(text, tmpPath);
        const produced =
          result.exitCode === 0 &&
          (yield* fileSystem.exists(tmpPath).pipe(Effect.orElseSucceed(() => false)));

        if (!produced) {
          yield* fileSystem.remove(tmpPath, { force: true }).pipe(Effect.ignore);
          return yield* new TtsUnavailableError({
            reason: trimDetail(result.stderr || `exit code ${result.exitCode}`),
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
            return yield* new TtsUnavailableError({
              reason: "could not store synthesized audio",
            });
          }
        }
      }

      const asset = yield* AssetAccess.issueTtsAudioUrl({
        filePath: audioPath,
        fileName: "speech.wav",
      }).pipe(Effect.provideService(AssetSigner.AssetSigner, assetSigner));
      return {
        url: asset.relativeUrl,
        cached,
        expiresAt: asset.expiresAt,
      } satisfies TtsSynthesized;
    });

    return { synthesize } satisfies TtsService;
  }),
);
