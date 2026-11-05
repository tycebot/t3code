import { memo, useEffect, useState } from "react";
import { Square, Volume2, VolumeX } from "lucide";
import { LoaderCircleIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PrimaryEnvironmentHttpClient } from "~/environments/primary/httpClient";
import { runPrimaryHttp } from "~/lib/runtime";
import { cn } from "~/lib/utils";
import { useSpeechPlayback } from "./speechPlayback";

const FAILURE_FLASH_MS = 2500;

export const MessageSpeakButton = memo(function MessageSpeakButton({
  messageId,
  text,
  label = "Read aloud",
  variant = "outline",
  size = "xs",
  className,
}: {
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
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a window timer keeps the failure flash alive for a fixed duration outside React
  useEffect(() => {
    if (!failed) return;
    const timer = window.setTimeout(() => setFailed(false), FAILURE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [failed]);

  const handleClick = () => {
    const store = useSpeechPlayback.getState();
    if (store.activeMessageId === messageId && store.phase !== "idle") {
      store.settle();
      return;
    }
    store.beginLoading(messageId);
    void runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.tts.synthesize({ headers: {}, payload: { text } })),
        Effect.map((result) => result.url),
        Effect.orElseSucceed(() => null),
      ),
    )
      .then((url) => {
        if (url === null) {
          const current = useSpeechPlayback.getState();
          if (current.activeMessageId === messageId) current.settle();
          setFailed(true);
          return;
        }
        useSpeechPlayback.getState().beginPlaying(messageId, url);
      })
      .catch(() => {
        const current = useSpeechPlayback.getState();
        if (current.activeMessageId === messageId) current.settle();
        setFailed(true);
      });
  };

  const tooltip =
    phase === "playing"
      ? "Stop reading"
      : phase === "loading"
        ? "Preparing speech…"
        : failed
          ? "Speech is unavailable on this environment"
          : label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={tooltip}
            aria-pressed={phase !== "idle"}
            data-speak-phase={phase}
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
            className={cn("size-3", (phase === "playing" || failed) && "text-primary")}
            icon={phase === "playing" ? Square : failed ? VolumeX : Volume2}
          />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{tooltip}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
