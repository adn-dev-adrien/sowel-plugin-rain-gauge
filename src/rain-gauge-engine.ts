/**
 * Rain gauge engine — listens to the Zigbee door contact on MQTT and publishes a
 * device with the exact data contract of the Netatmo rain module (`rain`,
 * `sum_rain_1`, `sum_rain_24`, `battery`), so every rain feature of Sowel
 * (Weather widget, 1 h / 24 h cumuls, bar charts) works unchanged.
 *
 * `rain` is the total of the CURRENT CLOCK HOUR, always written with the hour
 * start as `sourceTimestamp`. InfluxDB overwrites a point with the same tags and
 * timestamp, so each hour ends up as exactly one point holding that hour's
 * total: the hourly mean is the total, the daily bars sum hourly totals, and the
 * history writer's dedup (skipped for timestamped writes) never drops a tip.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MqttConnector } from "./mqtt-connector.js";
import { HOUR_MS, RainCounter, hourStart, type RainSnapshot } from "./rain-counter.js";

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: unknown): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
    sourceTimestamp?: number,
  ): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
}

/** The sensor reports at least hourly; past this silence it is offline. */
const SILENCE_OFFLINE_MS = 2.5 * HOUR_MS;
/** Rolling windows slide even when nothing tips. */
const TICK_MS = 60_000;

export interface EngineOptions {
  integrationId: string;
  sensorTopic: string;
  deviceId: string;
  mmPerTip: number;
  statePath: string;
}

export class RainGaugeEngine {
  private readonly counter: RainCounter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private publishedHour = 0;
  private lastMessageAt = 0;
  private availabilitySeen = false;

  constructor(
    private readonly opts: EngineOptions,
    private readonly mqtt: MqttConnector,
    private readonly deviceManager: DeviceManager,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.counter = new RainCounter(opts.mmPerTip, this.loadState(), this.now());
  }

  start(): void {
    this.deviceManager.upsertFromDiscovery(this.opts.integrationId, this.opts.integrationId, {
      friendlyName: this.opts.deviceId,
      manufacturer: "Tipping bucket",
      model: "Rain Gauge",
      data: [
        { key: "rain", type: "number", category: "rain", unit: "mm" },
        { key: "sum_rain_1", type: "number", category: "rain", unit: "mm" },
        { key: "sum_rain_24", type: "number", category: "rain", unit: "mm" },
        { key: "battery", type: "number", category: "battery", unit: "%" },
        { key: "tips_total", type: "number", category: "generic" },
      ],
      orders: [],
    });

    this.mqtt.subscribe(this.opts.sensorTopic, (_t, payload) => this.handleState(payload));
    this.mqtt.subscribe(`${this.opts.sensorTopic}/availability`, (_t, payload) =>
      this.handleAvailability(payload),
    );

    this.publish();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.logger.info(
      { topic: this.opts.sensorTopic, mmPerTip: Number(this.opts.mmPerTip.toFixed(4)) },
      "Rain gauge listening",
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.saveState();
  }

  /** One Z2M state message of the contact sensor. */
  handleState(payload: Buffer): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload.toString("utf-8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const now = this.now();
    this.lastMessageAt = now;
    this.deviceManager.updateDeviceStatus(this.opts.integrationId, this.opts.deviceId, "online");

    if (typeof json.battery === "number") {
      this.deviceManager.updateDeviceData(this.opts.integrationId, this.opts.deviceId, {
        battery: json.battery,
      });
    }

    if (typeof json.contact !== "boolean") return;
    const outcome = this.counter.onContact(json.contact, now);
    if (outcome === "tip") {
      this.logger.debug({ hour: this.counter.currentHour(now) }, "Bucket tipped");
      this.publish();
    } else if (outcome === "bounce") {
      this.logger.debug({ contact: json.contact }, "Contact bounce ignored");
    }
    this.saveState();
  }

  /** Z2M availability: `{"state":"online"}` (or a bare `online` in legacy mode). */
  handleAvailability(payload: Buffer): void {
    const raw = payload.toString("utf-8").trim();
    let state = raw;
    try {
      const json = JSON.parse(raw) as { state?: unknown };
      if (typeof json.state === "string") state = json.state;
    } catch {
      // legacy plain string
    }
    if (state !== "online" && state !== "offline") return;
    this.availabilitySeen = true;
    this.deviceManager.updateDeviceStatus(this.opts.integrationId, this.opts.deviceId, state);
  }

  tick(): void {
    const now = this.now();
    // Without Z2M availability, fall back on silence.
    if (!this.availabilitySeen && this.lastMessageAt > 0 && now - this.lastMessageAt > SILENCE_OFFLINE_MS) {
      this.deviceManager.updateDeviceStatus(this.opts.integrationId, this.opts.deviceId, "offline");
    }
    this.publish();
  }

  private publish(): void {
    const now = this.now();
    const hour = hourStart(now);
    // Timestamped write: one point per hour, overwritten until the hour closes.
    this.deviceManager.updateDeviceData(
      this.opts.integrationId,
      this.opts.deviceId,
      { rain: this.counter.currentHour(now) },
      Math.floor(hour / 1000), // Sowel's InfluxDB write precision is seconds
    );
    this.deviceManager.updateDeviceData(this.opts.integrationId, this.opts.deviceId, {
      sum_rain_1: this.counter.rolling(HOUR_MS, now),
      sum_rain_24: this.counter.rolling(24 * HOUR_MS, now),
      tips_total: this.counter.getTipsTotal(),
    });
    if (hour !== this.publishedHour) {
      this.publishedHour = hour;
      this.saveState();
    }
  }

  private loadState(): RainSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.opts.statePath, "utf-8")) as RainSnapshot;
    } catch {
      return undefined;
    }
  }

  private saveState(): void {
    try {
      writeFileSync(this.opts.statePath, JSON.stringify(this.counter.snapshot(this.now())));
    } catch (err) {
      this.logger.warn({ err } as Record<string, unknown>, "Could not persist rain gauge state");
    }
  }
}

export function statePathIn(pluginDir: string): string {
  return resolve(pluginDir, "state.json");
}
