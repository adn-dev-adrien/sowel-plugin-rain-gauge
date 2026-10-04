import { describe, expect, it } from "vitest";
import { HOUR_MS, RainCounter, hourStart, mmPerTip } from "./rain-counter.js";

const T0 = Date.UTC(2026, 9, 4, 14, 0, 0); // 14:00:00 UTC

describe("mmPerTip", () => {
  it("matches the model's 0.550 mm for 5 ml in a 107.58 mm funnel", () => {
    expect(mmPerTip(5, 107.58)).toBeCloseTo(0.55, 3);
  });
});

describe("RainCounter", () => {
  it("takes the first value as a baseline, not a tip", () => {
    const c = new RainCounter(0.55, undefined, T0);
    expect(c.onContact(false, T0)).toBe("baseline");
    expect(c.currentHour(T0)).toBe(0);
  });

  it("counts a flip in either direction", () => {
    const c = new RainCounter(0.55, undefined, T0);
    c.onContact(false, T0);
    expect(c.onContact(true, T0 + 60_000)).toBe("tip");
    expect(c.onContact(false, T0 + 120_000)).toBe("tip");
    expect(c.currentHour(T0 + 130_000)).toBe(1.1);
    expect(c.getTipsTotal()).toBe(2);
  });

  it("ignores Z2M republishing the same contact value", () => {
    const c = new RainCounter(0.55, undefined, T0);
    c.onContact(false, T0);
    expect(c.onContact(false, T0 + 55 * 60_000)).toBe("unchanged");
    expect(c.getTipsTotal()).toBe(0);
  });

  it("ignores magnet bounce within 2 s and follows the settled value", () => {
    const c = new RainCounter(0.55, undefined, T0);
    c.onContact(false, T0);
    expect(c.onContact(true, T0 + 10_000)).toBe("tip");
    expect(c.onContact(false, T0 + 10_400)).toBe("bounce");
    expect(c.onContact(true, T0 + 10_800)).toBe("bounce");
    expect(c.onContact(false, T0 + 60_000)).toBe("tip");
    expect(c.getTipsTotal()).toBe(2);
  });

  it("splits the current hour from the rolling windows", () => {
    const c = new RainCounter(0.5, undefined, T0);
    c.onContact(false, T0 - 30 * 60_000);
    c.onContact(true, T0 - 20 * 60_000); // 13:40, previous hour
    c.onContact(false, T0 + 10 * 60_000); // 14:10
    const now = T0 + 15 * 60_000;
    expect(c.currentHour(now)).toBe(0.5);
    expect(c.rolling(HOUR_MS, now)).toBe(1);
    expect(c.rolling(24 * HOUR_MS, now + 2 * HOUR_MS)).toBe(1);
    expect(c.rolling(HOUR_MS, now + 2 * HOUR_MS)).toBe(0);
  });

  it("drops tips older than the 24 h window", () => {
    const c = new RainCounter(0.55, undefined, T0);
    c.onContact(false, T0);
    c.onContact(true, T0 + 1000 * 5);
    expect(c.rolling(24 * HOUR_MS, T0 + 25 * HOUR_MS)).toBe(0);
    expect(c.snapshot(T0 + 26 * HOUR_MS).tips).toEqual([]);
  });

  it("restores tips and catches a tip that happened while down", () => {
    const a = new RainCounter(0.55, undefined, T0);
    a.onContact(false, T0);
    a.onContact(true, T0 + 60_000);
    const snap = a.snapshot(T0 + 60_000);

    const b = new RainCounter(0.55, snap, T0 + 5 * 60_000);
    expect(b.currentHour(T0 + 5 * 60_000)).toBe(0.55);
    // last seen `true`; the bucket tipped during the restart
    expect(b.onContact(false, T0 + 6 * 60_000)).toBe("tip");
  });

  it("does not trust a stale persisted contact as a baseline", () => {
    const a = new RainCounter(0.55, undefined, T0);
    a.onContact(true, T0);
    const b = new RainCounter(0.55, a.snapshot(T0), T0 + 3 * HOUR_MS);
    expect(b.onContact(false, T0 + 3 * HOUR_MS)).toBe("baseline");
  });
});

describe("hourStart", () => {
  it("floors to the clock hour", () => {
    expect(hourStart(T0 + 59 * 60_000 + 59_000)).toBe(T0);
  });
});
