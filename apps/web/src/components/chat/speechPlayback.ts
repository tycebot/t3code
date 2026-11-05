import { create } from "zustand";

// One shared speech lane for the timeline: a new message stops the previous
// one, and a module-owned HTMLAudioElement outlives row virtualization.
// Every takeover bumps `generation`; async callbacks carrying a stale
// generation are dropped, so slow responses never interrupt newer speech.

export type SpeechPhase = "idle" | "loading" | "playing" | "failed";

interface SpeechPlaybackState {
  readonly activeMessageId: string | null;
  readonly phase: SpeechPhase;
  readonly failureReason: string | null;
  readonly generation: number;
  beginLoading: (messageId: string) => number;
  beginPlaying: (messageId: string, generation: number, url: string) => void;
  fail: (messageId: string, generation: number, reason: string) => void;
  settle: () => void;
}

const FAILURE_FLASH_MS = 4000;

let element: HTMLAudioElement | null = null;
let failureTimer: number | null = null;

function detachAudio() {
  if (!element) return;
  element.pause();
  element.removeAttribute("src");
  element.load();
  element = null;
}

function clearFailureTimer() {
  if (failureTimer === null) return;
  window.clearTimeout(failureTimer);
  failureTimer = null;
}

export const useSpeechPlayback = create<SpeechPlaybackState>((set, get) => ({
  activeMessageId: null,
  phase: "idle",
  failureReason: null,
  generation: 0,

  beginLoading: (messageId) => {
    detachAudio();
    clearFailureTimer();
    const generation = get().generation + 1;
    set({ activeMessageId: messageId, phase: "loading", failureReason: null, generation });
    return generation;
  },

  beginPlaying: (messageId, generation, url) => {
    // A newer click (or a stop) won the request race; discard this take.
    const state = get();
    if (
      state.generation !== generation ||
      state.activeMessageId !== messageId ||
      state.phase !== "loading"
    ) {
      return;
    }
    detachAudio();
    const audio = new Audio(url);
    const settled = () => {
      if (element !== audio) return;
      detachAudio();
      set({ activeMessageId: null, phase: "idle", failureReason: null });
    };
    audio.addEventListener("ended", settled);
    audio.addEventListener("error", settled);
    element = audio;
    set({ activeMessageId: messageId, phase: "playing", failureReason: null });
    void audio.play().catch(settled);
  },

  fail: (messageId, generation, reason) => {
    const state = get();
    if (state.generation !== generation || state.activeMessageId !== messageId) return;
    detachAudio();
    set({ phase: "failed", failureReason: reason });
    clearFailureTimer();
    failureTimer = window.setTimeout(() => {
      failureTimer = null;
      const current = get();
      if (current.phase === "failed" && current.generation === generation) {
        set({ activeMessageId: null, phase: "idle", failureReason: null });
      }
    }, FAILURE_FLASH_MS);
  },

  settle: () => {
    detachAudio();
    clearFailureTimer();
    set({ activeMessageId: null, phase: "idle", failureReason: null });
  },
}));
