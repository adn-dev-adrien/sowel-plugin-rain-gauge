# Spec 001 — Tipping-bucket rain gauge from a Zigbee door contact

Status: decided 2026-10-04 — implemented in v0.1.0.

## Context

A 3D-printed tipping-bucket rain gauge carries a magnet; an Aqara door contact
sensor (T1, `MCCGQ12LM`) sits next to it. Each time a bucket fills up (5 ml,
calibrated with a syringe) it tips over and the `contact` value flips. One tip
in either direction = one bucket emptied.

Rain height per tip comes from the funnel area:

```
r     = 53.79 mm            (funnel diameter 107.58 mm)
A     = π × r² ≈ 9090.03 mm²
V     = 5 ml = 5000 mm³
h     = V / A ≈ 0.550 mm per tip
```

The sensor is already paired on Adrien's instance: friendly name `Pluviometre`
on the `zigbee2mqtt_maison2` network. Observed behaviour:

- payload is not retained;
- Z2M republishes the full state (`contact`, `battery`, `linkquality`, …) about
  every 55 minutes even when nothing tipped;
- link quality is weak (14–58), so a missed message is a real possibility.

## What Sowel already does

Nothing needs to change in the core for the base feature. The `rain` category
is already a first-class cumulative category (the Netatmo rain gauge uses it):

- `rain` (incremental) is historized by default; `sum_rain_1` / `sum_rain_24`
  (rolling native totals) are live-only (`ALIAS_DEFAULTS_OFF`).
- `WeatherAggregator` exposes `rain_1h` / `rain_24h` on any `weather` equipment,
  preferring the native `sum_rain_*` bindings when present.
- `HistoryPanel` draws `rain` as bars (`HistoryBarChart`): 24 h → one bar per
  hour, 7 d / 30 d → one bar per day (sum of hourly means, `history-query.ts`).
- The Weather widget and `WeatherPanel` show 1 h / 24 h totals.

## Proposal: plugin `rain-gauge`

An integration plugin (apiVersion 2) that listens to the contact sensor directly
on the MQTT broker and turns tips into rain.

### Settings (manifest)

| key | type | default | validation |
| --- | --- | --- | --- |
| `mqtt_url` | text | — (required) | `mqtt://` or `mqtts://` URL |
| `mqtt_username` / `mqtt_password` | text / password | — | — |
| `mqtt_client_id` | text | `sowel-rain-gauge` | — |
| `sensor_topic` | text | `zigbee2mqtt/Pluviometre` | required, no `#` / `+` wildcard |
| `bucket_ml` | number | `5` | 0.5 – 50 |
| `funnel_diameter_mm` | number | `107.58` | 20 – 500 |

`mm_per_tip = bucket_ml × 1000 / (π × (funnel_diameter_mm / 2)²)`, logged at
start. An invalid setting puts the integration in error with a French message
naming the field; nothing is counted with a wrong factor.

### Tip detection

- Subscribe to `<sensor_topic>` and `<sensor_topic>/availability`.
- The first message after (re)connection only sets the baseline — not a tip.
- A tip is a **change** of `contact` (`true → false` or `false → true`).
  A republication with the same value is ignored.
- Debounce: a change less than 2 s after the previous counted tip is ignored
  (magnet bounce). 2 s is far below the fastest real cadence (~40 s per tip at
  50 mm/h).

### Published device

One device, `sourceDeviceId` = the Z2M friendly name, model `Tipping bucket`:

| key | category | unit | historized | meaning |
| --- | --- | --- | --- | --- |
| `rain` | `rain` | mm | yes (default) | rain fallen in the **current clock hour** |
| `sum_rain_1` | `rain` | mm | no (default) | rolling last 60 min |
| `sum_rain_24` | `rain` | mm | no (default) | rolling last 24 h |
| `tips_total` | — | — | no | lifetime tip count (diagnostics) |

`rain` is published with `sourceTimestamp` = start of the current hour, on every
tip and at every hour boundary (0 for a new dry hour). Same tags + same timestamp
overwrite in InfluxDB, so there is **exactly one point per hour** whose value is
that hour's total. This is what makes every existing reader right at once:

- the hourly bucket's mean of one point is the hour's total;
- the daily bars sum hourly totals;
- `sourceTimestamp` skips the writer's dedup (min interval, max interval), so
  no tip is lost and no zero is double-counted.

Tip timestamps for the last 25 h are kept in `<pluginDir>/tips.json` so a
restart during rain keeps the current hour and the rolling totals right.

### Availability (spec 116)

`device.status` follows `<sensor_topic>/availability` when Z2M publishes it;
otherwise `offline` after 2 h 30 without any message (the sensor reports at
least hourly).

### Equipment

Adrien creates a `weather` equipment "Pluviomètre" bound to the device. That
gives the Weather widget (1 h / 24 h) and the bar chart on the equipment page
with no further work.

## Out of scope

- No core change for the base feature.
- No reading through the Zigbee2MQTT plugin: plugins cannot subscribe to
  another integration's devices (spec 111), and the raw contact device stays
  where it is.
- No back-fill: rain before the plugin starts is not reconstructed.
- 30 days max on the chart (Sowel's longest range), not 31 like the HA card.

## Risks

- A tip during a Zigbee or broker outage is lost; nothing can recover it.
- Two tips during one outage cancel out (`contact` ends where it started).

## Decisions (2026-10-04)

Adrien: "reuse the existing as much as possible — ideally just plug into the Netatmo
one". The Netatmo plugin itself cannot be fed (it pulls the Netatmo cloud, and no
Netatmo station is installed), so the plugin copies the Netatmo rain module's data
contract instead. Consequently:

1. **Bar colours** — Sowel's existing uniform blue. No core change.
2. **Widget window** — rolling 1 h / 24 h, as for Netatmo. "Today" is the last bar
   of the 30-day chart.
3. **Distribution** — personal source (spec 136) first; still to be confirmed.

Side finding: `plugin-development.md` says `sourceTimestamp` is in milliseconds, but the
InfluxDB write API uses precision `"s"` (`influx-client.ts`). The plugin passes seconds,
like `sowel-plugin-legrand-energy`.
