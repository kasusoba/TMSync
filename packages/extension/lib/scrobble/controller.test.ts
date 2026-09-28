import type { RecordPhase } from "@/lib/tracker/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrobbleController, type VideoLike } from "./controller";

interface Event {
  action: RecordPhase;
  progress: number;
}

function setup(duration = 100) {
  const video: VideoLike = { currentTime: 0, duration, ended: false };
  const events: Event[] = [];
  const controller = new ScrobbleController(video, (action, progress) => {
    events.push({ action, progress });
  });
  return { video, events, controller };
}

const tick = () => vi.advanceTimersByTime(800);

describe("ScrobbleController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits one start on play (after debounce) with progress", () => {
    const { video, events, controller } = setup();
    video.currentTime = 10; // 10%
    controller.play();
    expect(events).toEqual([]); // debounced, not yet
    tick();
    expect(events).toEqual([{ action: "start", progress: 10 }]);
  });

  it("coalesces rapid play/pause bursts to the final state (seeking)", () => {
    const { events, controller } = setup();
    controller.play();
    controller.pause();
    controller.play(); // settle on playing
    tick();
    expect(events).toEqual([{ action: "start", progress: 0 }]);
  });

  it("does not emit a duplicate start (one start per session)", () => {
    const { events, controller } = setup();
    controller.play();
    tick();
    controller.play();
    tick();
    expect(events).toEqual([{ action: "start", progress: 0 }]);
  });

  it("emits pause then start again on resume", () => {
    const { video, events, controller } = setup();
    controller.play();
    tick();
    video.currentTime = 30;
    controller.pause();
    tick();
    video.currentTime = 35;
    controller.play();
    tick();
    expect(events).toEqual([
      { action: "start", progress: 0 },
      { action: "pause", progress: 30 },
      { action: "start", progress: 35 },
    ]);
  });

  it("auto-commits a stop once playback crosses the threshold (no pause needed)", () => {
    const { video, events, controller } = setup();
    controller.play();
    tick();
    video.currentTime = 85; // crosses the 80% default while playing
    controller.progressTick();
    expect(events).toEqual([
      { action: "start", progress: 0 },
      { action: "stop", progress: 85 },
    ]);
    // Keeps playing to the end → no further scrobbles (idempotent).
    video.currentTime = 100;
    controller.progressTick();
    controller.ended();
    expect(events.filter((e) => e.action === "stop")).toHaveLength(1);
  });

  it("does not commit on tick before the threshold or before any start", () => {
    const { video, events, controller } = setup();
    video.currentTime = 90;
    controller.progressTick(); // not started yet → nothing
    expect(events).toEqual([]);
    video.currentTime = 10;
    controller.play();
    tick();
    video.currentTime = 50;
    controller.progressTick(); // below threshold → nothing new
    expect(events).toEqual([{ action: "start", progress: 10 }]);
  });

  it("converts a pause past the watched threshold into a stop (commit to history)", () => {
    const { video, events, controller } = setup();
    controller.play();
    tick();
    video.currentTime = 93; // 93% ≥ 80% default threshold
    controller.pause();
    tick();
    expect(events).toEqual([
      { action: "start", progress: 0 },
      { action: "stop", progress: 93 },
    ]);
    // Idempotent afterwards: a later resume/pause does not re-scrobble.
    controller.play();
    tick();
    expect(events.filter((e) => e.action === "stop")).toHaveLength(1);
  });

  it("still pauses normally below the watched threshold", () => {
    const { video, events, controller } = setup();
    controller.play();
    tick();
    video.currentTime = 50;
    controller.pause();
    tick();
    expect(events).toEqual([
      { action: "start", progress: 0 },
      { action: "pause", progress: 50 },
    ]);
  });

  it("ignores a pause before any start", () => {
    const { events, controller } = setup();
    controller.pause();
    tick();
    expect(events).toEqual([]);
  });

  it("stops at ~100 on ended and ignores later events", () => {
    const { events, controller } = setup();
    controller.play();
    tick();
    controller.ended();
    controller.play();
    tick();
    expect(events).toEqual([
      { action: "start", progress: 0 },
      { action: "stop", progress: 100 },
    ]);
  });

  it("stops with last progress on leave (before ended)", () => {
    const { video, events, controller } = setup();
    controller.play();
    tick();
    video.currentTime = 42.5;
    controller.leave();
    expect(events).toEqual([
      { action: "start", progress: 0 },
      { action: "stop", progress: 42.5 },
    ]);
  });

  it("does not stop on leave if nothing ever started", () => {
    const { events, controller } = setup();
    controller.leave();
    expect(events).toEqual([]);
  });

  it("never double-stops (ended then leave)", () => {
    const { events, controller } = setup();
    controller.play();
    tick();
    controller.ended();
    controller.leave();
    expect(events.filter((e) => e.action === "stop")).toHaveLength(1);
  });
});
