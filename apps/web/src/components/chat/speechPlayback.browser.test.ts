import { describe, expect, it } from "vite-plus/test";

import { useSpeechPlayback } from "./speechPlayback";

function resetLane() {
  useSpeechPlayback.setState({
    activeMessageId: null,
    phase: "idle",
    failureReason: null,
    generation: 0,
  });
}

describe("speechPlayback lane", () => {
  it("beginLoading hands back a generation and claims the lane", () => {
    resetLane();
    const first = useSpeechPlayback.getState().beginLoading("m1");
    expect(first).toBe(1);
    expect(useSpeechPlayback.getState().phase).toBe("loading");

    const second = useSpeechPlayback.getState().beginLoading("m2");
    expect(second).toBeGreaterThan(first);
    expect(useSpeechPlayback.getState().activeMessageId).toBe("m2");
  });

  it("drops playback callbacks from a stale generation", () => {
    resetLane();
    const stale = useSpeechPlayback.getState().beginLoading("m1");
    useSpeechPlayback.getState().beginLoading("m2");
    useSpeechPlayback.getState().beginPlaying("m1", stale, "http://localhost/stale.wav");

    const state = useSpeechPlayback.getState();
    expect(state.phase).toBe("loading");
    expect(state.activeMessageId).toBe("m2");
  });

  it("stops accepting the older message when the same message is re-clicked", () => {
    resetLane();
    const first = useSpeechPlayback.getState().beginLoading("m1");
    useSpeechPlayback.getState().settle();
    const second = useSpeechPlayback.getState().beginLoading("m1");
    useSpeechPlayback.getState().beginPlaying("m1", first, "http://localhost/old.wav");

    expect(useSpeechPlayback.getState().phase).toBe("loading");
    expect(useSpeechPlayback.getState().generation).toBe(second);
  });

  it("records failures only for the current generation", () => {
    resetLane();
    const stale = useSpeechPlayback.getState().beginLoading("m1");
    const current = useSpeechPlayback.getState().beginLoading("m2");

    useSpeechPlayback.getState().fail("m1", stale, "old engine died");
    expect(useSpeechPlayback.getState().phase).toBe("loading");

    useSpeechPlayback.getState().fail("m2", current, "engine died");
    const state = useSpeechPlayback.getState();
    expect(state.phase).toBe("failed");
    expect(state.failureReason).toBe("engine died");
  });

  it("settle returns the lane to idle", () => {
    resetLane();
    useSpeechPlayback.getState().beginLoading("m1");
    useSpeechPlayback.getState().settle();
    const state = useSpeechPlayback.getState();
    expect(state.phase).toBe("idle");
    expect(state.activeMessageId).toBeNull();
    expect(state.failureReason).toBeNull();
  });
});
