import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RainGaugeEngine, type DeviceManager, type Logger } from "./rain-gauge-engine.js";
import type { MqttConnector } from "./mqtt-connector.js";
import { parseGaugeSettings } from "./settings.js";

const T0 = Date.UTC(2026, 9, 4, 14, 0, 0);

interface DataCall {
  payload: Record<string, unknown>;
  ts?: number;
}

function setup() {
  let now = T0;
  const data: DataCall[] = [];
  const statuses: string[] = [];
  const handlers = new Map<string, (t: string, p: Buffer) => void>();
  const dm: DeviceManager = {
    upsertFromDiscovery: () => {},
    updateDeviceData: (_i, _d, payload, ts) => data.push({ payload, ts }),
    updateDeviceStatus: (_i, _d, s) => statuses.push(s),
  };
  const mqtt = { subscribe: (t: string, h: (t: string, p: Buffer) => void) => handlers.set(t, h) };
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger } as unknown as Logger;
  const engine = new RainGaugeEngine(
    {
      integrationId: "rain-gauge",
      sensorTopic: "z2m/Pluviometre",
      deviceId: "Pluviometre",
      mmPerTip: 0.55,
      statePath: join(mkdtempSync(join(tmpdir(), "rg-")), "state.json"),
    },
    mqtt as unknown as MqttConnector,
    dm,
    logger,
    () => now,
  );
  engine.start();
  const send = (topic: string, body: unknown) =>
    handlers.get(topic)!(topic, Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
  return {
    engine,
    data,
    statuses,
    send,
    setNow: (t: number) => (now = t),
    rainWrites: () => data.filter((c) => "rain" in c.payload),
  };
}

describe("RainGaugeEngine", () => {
  it("writes rain as the current hour total, stamped at the hour start in seconds", () => {
    const s = setup();
    s.setNow(T0 + 5 * 60_000);
    s.send("z2m/Pluviometre", { contact: false, battery: 100 });
    s.setNow(T0 + 6 * 60_000);
    s.send("z2m/Pluviometre", { contact: true });
    s.setNow(T0 + 7 * 60_000);
    s.send("z2m/Pluviometre", { contact: false });

    const last = s.rainWrites().at(-1)!;
    expect(last.payload.rain).toBe(1.1);
    expect(last.ts).toBe(T0 / 1000);
    expect(s.data.some((c) => c.payload.battery === 100 && c.ts === undefined)).toBe(true);
  });

  it("opens a new hour at 0 on the next tick", () => {
    const s = setup();
    s.send("z2m/Pluviometre", { contact: false });
    s.setNow(T0 + 30 * 60_000);
    s.send("z2m/Pluviometre", { contact: true });
    s.setNow(T0 + 61 * 60_000);
    s.engine.tick();
    const last = s.rainWrites().at(-1)!;
    expect(last.payload.rain).toBe(0);
    expect(last.ts).toBe((T0 + 3_600_000) / 1000);
    const rolling = s.data.filter((c) => "sum_rain_1" in c.payload).at(-1)!;
    expect(rolling.payload.sum_rain_1).toBe(0.55);
    expect(rolling.ts).toBeUndefined();
  });

  it("follows Z2M availability, and falls back on silence without it", () => {
    const s = setup();
    s.send("z2m/Pluviometre/availability", { state: "offline" });
    expect(s.statuses.at(-1)).toBe("offline");

    const t = setup();
    t.send("z2m/Pluviometre", { contact: false });
    expect(t.statuses.at(-1)).toBe("online");
    t.setNow(T0 + 3 * 3_600_000);
    t.engine.tick();
    expect(t.statuses.at(-1)).toBe("offline");
  });

  it("ignores payloads that are not JSON", () => {
    const s = setup();
    const before = s.data.length;
    s.send("z2m/Pluviometre", "not json");
    expect(s.data.length).toBe(before);
  });
});

describe("parseGaugeSettings", () => {
  const from = (o: Record<string, string>) => (k: string) => o[k];

  it("uses the defaults and accepts a decimal comma", () => {
    const r = parseGaugeSettings(from({ bucket_ml: "4,8" }));
    expect(r.ok && r.settings).toEqual({
      sensorTopic: "zigbee2mqtt/Pluviometre",
      bucketMl: 4.8,
      funnelRadiusMm: 55,
    });
  });

  it("refuses a wildcard topic and out-of-range calibration", () => {
    const r = parseGaugeSettings(from({ sensor_topic: "z2m/#", bucket_ml: "0", funnel_radius_mm: "5" }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toHaveLength(3);
  });
});
