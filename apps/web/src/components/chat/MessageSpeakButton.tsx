import { memo } from "react";
import { Square, Volume2, VolumeX } from "lucide";
import { LoaderCircleIcon } from "lucide-react";
import { TTS_MAX_TEXT_LENGTH, type EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { MorphIcon } from "~/components/MorphIcon";
import { usePreparedConnection } from "~/state/session";
import { ttsSynthesize } from "~/state/tts";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useSpeechPlayback } from "./speechPlayback";

// The request goes to the environment that owns the thread (and its local
// speech engine) over that environment's RPC connection; the returned signed
// audio path is resolved against the same environment's HTTP origin, so
// remote and desktop setups play back without the browser guessing URLs.

function failureReason(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "TtsUnavailableError" &&
    "reason" in error &&
    typeof error.reason === "string"
  ) {
    return error.reason;
  }
  return "speech synthesis failed";
}

export const MessageSpeakButton = memo(function MessageSpeakButton({
  environmentId,
  messageId,
  text,
  label = "Read aloud",
  variant = "outline",
  size = "xs",
  className,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly messageId: string;
  readonly text: string;
  readonly label?: string;
  readonly variant?: "outline" | "ghost";
  readonly size?: "xs" | "sm";
  readonly className?: string;
}) {
  const phase = useSpeechPlayback((state) =>
    state.activeMessageId === messageId ? state.phase : "idle",
  );
  const failureReasonText = useSpeechPlayback((state) =>
    state.activeMessageId === messageId ? state.failureReason : null,
  );
  const synthesize = useAtomCommand(ttsSynthesize, { reportFailure: false });
  const connection = usePreparedConnection(environmentId);

  const tooLong = text.length > TTS_MAX_TEXT_LENGTH;
  const unavailableReason = tooLong
    ? "Message is too long to read aloud"
    : environmentId === null
      ? "Connect to this environment to read aloud"
      : null;
  const disabled = phase === "idle" && unavailableReason !== null;

  const handleClick = () => {
    const store = useSpeechPlayback.getState();
    if (store.activeMessageId === messageId && store.phase !== "idle") {
      store.settle();
      return;
    }
    if (environmentId === null || tooLong) return;
    const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
    const generation = store.beginLoading(messageId);
    void synthesize({ environmentId, input: { text } }).then(
      (result) => {
        if (result._tag === "Failure") {
          useSpeechPlayback
            .getState()
            .fail(messageId, generation, failureReason(squashAtomCommandFailure(result)));
          return;
        }
        if (httpBaseUrl === null) {
          useSpeechPlayback
            .getState()
            .fail(messageId, generation, "not connected to this environment");
          return;
        }
        const audioUrl = resolveAssetUrl(httpBaseUrl, result.value.url);
        if (audioUrl === null) {
          useSpeechPlayback
            .getState()
            .fail(messageId, generation, "could not resolve the audio URL");
          return;
        }
        useSpeechPlayback.getState().beginPlaying(messageId, generation, audioUrl);
      },
      () => {
        useSpeechPlayback.getState().fail(messageId, generation, "speech request failed");
      },
    );
  };

  const tooltip =
    unavailableReason ??
    (phase === "playing"
      ? "Stop reading"
      : phase === "loading"
        ? "Preparing speech…"
        : phase === "failed"
          ? `Couldn’t read aloud: ${failureReasonText ?? "unknown error"}`
          : label);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={tooltip}
              aria-pressed={phase !== "idle"}
              data-speak-phase={phase}
              disabled={disabled}
              onClick={handleClick}
              size={size}
              type="button"
              variant={variant === "ghost" ? "ghost-muted" : variant}
              className={className}
            />
          }
        >
          {phase === "loading" ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : (
            <MorphIcon
              className={cn(
                "size-3",
                (phase === "playing" || phase === "failed") && "text-primary",
              )}
              icon={phase === "playing" ? Square : phase === "failed" ? VolumeX : Volume2}
            />
          )}
        </TooltipTrigger>
        <TooltipPopup>
          <p>{tooltip}</p>
        </TooltipPopup>
      </Tooltip>
      {phase === "failed" && failureReasonText !== null ? (
        <p className="sr-only" role="status">
          Speech unavailable: {failureReasonText}
        </p>
      ) : null}
    </>
  );
});
