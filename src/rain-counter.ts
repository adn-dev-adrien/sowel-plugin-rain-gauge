/**
 * Rain counter — turns the contact flips of a tipping-bucket rain gauge into rain.
 *
 * A magnet on the see-saw drives a door contact: every time a bucket fills up it
 * tips over and `contact` flips. One flip in either direction = one bucket emptied
 * = `mmPerTip` of rain. Pure logic, no I/O: the plugin feeds it MQTT messages and
 * a clock, and persists `snapshot()`.
 */

/** Rain height (mm) of one bucket: V / A, with A = π × r² the funnel opening area. */
export function mmPerTip(bucketMl: number, funnelRadiusMm: number): number {
  return (bucketMl * 1000) / (Math.PI * funnelRadiusMm * funnelRadiusMm);
}

export const HOUR_MS = 3_600_000;
/** Tips are kept a little longer than the widest rolling window (24 h). */
const RETENTION_MS = 25 * HOUR_MS;
/** A flip closer than this to the previous counted tip is magnet bounce. */
export const DEBOUNCE_MS = 2_000;
/** A persisted contact older than this is not trusted as a baseline. */
const BASELINE_MAX_AGE_MS = 2 * HOUR_MS;

export type ContactOutcome = "baseline" | "tip" | "unchanged" | "bounce";

export interface RainSnapshot {
  /** Epoch ms of every counted tip in the retention window. */
  tips: number[];
  tipsTotal: number;
  lastContact: boolean | null;
  /** Epoch ms of the last contact value seen. */
  lastContactAt: number | null;
}

export function hourStart(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
}

/** Last midnight in the process time zone (Sowel's container runs in the house's). */
export function localMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export class RainCounter {
  private tips: number[];
  private tipsTotal: number;
  private lastContact: boolean | null;
  private lastContactAt: number | null;

  constructor(
    private readonly mmPerTipValue: number,
    restored?: RainSnapshot,
    nowMs: number = Date.now(),
  ) {
    this.tips = (restored?.tips ?? []).filter((t) => nowMs - t < RETENTION_MS).sort((a, b) => a - b);
    this.tipsTotal = restored?.tipsTotal ?? this.tips.length;
    // A tip that happened while Sowel was down is still caught when the next
    // message shows the other contact value — but only if that baseline is recent.
    const fresh =
      restored?.lastContactAt != null && nowMs - restored.lastContactAt < BASELINE_MAX_AGE_MS;
    this.lastContact = fresh ? restored!.lastContact : null;
    this.lastContactAt = fresh ? restored!.lastContactAt : null;
  }

  /** Feed one `contact` value from the sensor. */
  onContact(contact: boolean, nowMs: number): ContactOutcome {
    const previous = this.lastContact;
    this.lastContact = contact;
    this.lastContactAt = nowMs;

    if (previous === null) return "baseline";
    // Z2M republishes the whole state about hourly: same value, nothing tipped.
    if (previous === contact) return "unchanged";

    const lastTip = this.tips[this.tips.length - 1];
    if (lastTip !== undefined && nowMs - lastTip < DEBOUNCE_MS) return "bounce";

    this.tips.push(nowMs);
    this.tipsTotal++;
    this.prune(nowMs);
    return "tip";
  }

  /** Rain since the start of the current clock hour (mm). */
  currentHour(nowMs: number): number {
    return this.sumSince(hourStart(nowMs), nowMs);
  }

  /** Rain since local midnight (mm): the daily counter, back to 0 at 00:00. */
  today(nowMs: number): number {
    return this.sumSince(localMidnight(nowMs), nowMs);
  }

  /** Rain over the rolling window ending now (mm). */
  rolling(windowMs: number, nowMs: number): number {
    return this.sumSince(nowMs - windowMs, nowMs);
  }

  getTipsTotal(): number {
    return this.tipsTotal;
  }

  snapshot(nowMs: number): RainSnapshot {
    this.prune(nowMs);
    return {
      tips: [...this.tips],
      tipsTotal: this.tipsTotal,
      lastContact: this.lastContact,
      lastContactAt: this.lastContactAt,
    };
  }

  private sumSince(fromMs: number, nowMs: number): number {
    let n = 0;
    for (const t of this.tips) if (t >= fromMs && t <= nowMs) n++;
    return round2(n * this.mmPerTipValue);
  }

  private prune(nowMs: number): void {
    while (this.tips.length > 0 && nowMs - this.tips[0] >= RETENTION_MS) this.tips.shift();
  }
}
