# sowel-plugin-rain-gauge

Sowel integration for a **tipping-bucket rain gauge read through a Zigbee door contact**
(Aqara MCCGQ11LM / MCCGQ12LM T1, or any contact sensor exposed by Zigbee2MQTT).

A magnet on the see-saw drives the contact: each time a bucket fills up it tips over and
`contact` flips. One flip, in either direction, is one bucket emptied.

## What it does

- Subscribes to the sensor's Zigbee2MQTT topic and its `/availability` topic.
- Counts a tip on every **change** of `contact`; ignores the hourly republication of the
  same value, and a flip less than 2 s after the previous tip (magnet bounce).
- Publishes one device with the **same data contract as the Netatmo rain module**, so
  every rain feature of Sowel works unchanged (Weather widget, 1 h / 24 h cumuls, bar
  charts):

| key | category | historized | meaning |
| --- | --- | --- | --- |
| `rain` | `rain` | yes | rain of the current clock hour (mm) |
| `sum_rain_1` | `rain` | no | rolling last 60 min (mm) |
| `sum_rain_24` | `rain` | no | rolling last 24 h (mm) |
| `battery` | `battery` | yes | sensor battery (%) |
| `tips_total` | `generic` | no | lifetime tip count (diagnostics) |

`rain` is written with the **start of the hour as its timestamp**, so each hour is exactly
one point in InfluxDB holding that hour's total.

Tips of the last 25 h are kept in `plugins/rain-gauge/state.json`, so a restart during
rain keeps the totals right.

## Settings

| setting | default | |
| --- | --- | --- |
| MQTT broker URL | — | same broker as Zigbee2MQTT |
| Sensor topic | `zigbee2mqtt/Pluviometre` | `<base_topic>/<friendly_name>`; the friendly name becomes the device name |
| Bucket volume (ml) | `5` | volume that makes one bucket tip (syringe calibration) |
| Funnel diameter (mm) | `107.58` | opening of the gauge's funnel |

Rain per tip = bucket volume ÷ funnel area: 5000 mm³ ÷ (π × 53.79²) ≈ **0.550 mm**.
An out-of-range value stops the plugin rather than recording wrong rain.

## Use in Sowel

Create a **Weather** equipment and bind the rain gauge device to it.

## Limits

- A tip during a Zigbee or broker outage is lost.
- No back-fill: rain before the plugin starts is not reconstructed.
