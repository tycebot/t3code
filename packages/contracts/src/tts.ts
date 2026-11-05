import * as Schema from "effect/Schema";

/**
 * Longest assistant message the read-aloud button will synthesize. Long
 * enough for any realistic reply, short enough that a misfired request
 * cannot pin the host's speech engine for minutes. Clients disable the
 * button past this size instead of firing a request that must fail.
 */
export const TTS_MAX_TEXT_LENGTH = 20_000;

export const TtsSynthesizeInput = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(TTS_MAX_TEXT_LENGTH)),
});
export type TtsSynthesizeInput = typeof TtsSynthesizeInput.Type;

export const TtsSynthesizeResult = Schema.Struct({
  /** Signed asset path, relative to the environment origin, serving audio/wav. */
  url: Schema.String,
  /** True when the audio came from the server-side cache without synthesizing. */
  cached: Schema.Boolean,
  /** Millisecond timestamp when the signed URL stops serving. */
  expiresAt: Schema.Number,
});
export type TtsSynthesizeResult = typeof TtsSynthesizeResult.Type;

/** The environment could not produce speech: no engine, engine failure, or overload. */
export class TtsUnavailableError extends Schema.TaggedError<TtsUnavailableError>()(
  "TtsUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Speech synthesis is unavailable on this environment (${this.reason}).`;
  }
}
