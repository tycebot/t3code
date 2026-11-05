import { create } from "zustand";

// One shared speech lane for the whole timeline: starting a new message stops
// the previous one, mirroring how ChatGPT's read-aloud behaves. The module
// owns a single HTMLAudioElement so playback outlives row virtualization.

export type SpeechPhase = "idle" | "loading" | "playing";

interface SpeechPlaybackState {
  readonly activeMessageId: string | null;
  readonly phase: SpeechPhase;
  beginLoading: (messageId: string) => void;
  beginPlaying: (messageId: string, url: string) => void;
  settle: () => void;
}

let element: HTMLAudioElement | null = null;

function detach() {
  if (!element) return;
  element.pause();
  element.removeAttribute("src");
  element.load();
  element = null;
}

export const useSpeechPlayback = create<SpeechPlaybackState>((set, get) => ({
  activeMessageId: null,
  phase: "idle",

  beginLoading: (messageId) => {
    detach();
    set({ activeMessageId: messageId, phase: "loading" });
  },

  beginPlaying: (messageId, url) => {
    // A newer click (or a stop) won the request race; discard this take.
    if (get().activeMessageId !== messageId || get().phase !== "loading") return;
    detach();
    const audio = new Audio(url);
    const settled = () => {
      if (element !== audio) return;
      detach();
      set({ activeMessageId: null, phase: "idle" });
    };
    audio.addEventListener("ended", settled);
    audio.addEventListener("error", settled);
    element = audio;
    set({ activeMessageId: messageId, phase: "playing" });
    void audio.play().catch(settled);
  },

  settle: () => {
    detach();
    set({ activeMessageId: null, phase: "idle" });
  },
}));
