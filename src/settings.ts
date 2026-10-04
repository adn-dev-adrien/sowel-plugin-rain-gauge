/**
 * Settings validation — a rain gauge with a wrong factor silently records wrong
 * rain for good, so an invalid calibration stops the plugin instead.
 */

export const DEFAULT_SENSOR_TOPIC = "zigbee2mqtt/Pluviometre";
export const DEFAULT_BUCKET_ML = 5;
export const DEFAULT_FUNNEL_DIAMETER_MM = 107.58;

export interface GaugeSettings {
  sensorTopic: string;
  bucketMl: number;
  funnelDiameterMm: number;
}

export type SettingsResult =
  | { ok: true; settings: GaugeSettings }
  | { ok: false; errors: string[] };

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  // Accept the French decimal comma too.
  return Number(raw.trim().replace(",", "."));
}

export function parseGaugeSettings(get: (key: string) => string | undefined): SettingsResult {
  const errors: string[] = [];

  const sensorTopic = (get("sensor_topic") ?? DEFAULT_SENSOR_TOPIC).trim().replace(/\/+$/, "");
  if (!sensorTopic) errors.push("Topic du capteur : obligatoire.");
  else if (/[#+]/.test(sensorTopic))
    errors.push("Topic du capteur : pas de joker # ou +, un seul capteur.");

  const bucketMl = parseNumber(get("bucket_ml"), DEFAULT_BUCKET_ML);
  if (!Number.isFinite(bucketMl) || bucketMl < 0.5 || bucketMl > 50)
    errors.push("Volume d'un godet : entre 0,5 et 50 ml.");

  const funnelDiameterMm = parseNumber(get("funnel_diameter_mm"), DEFAULT_FUNNEL_DIAMETER_MM);
  if (!Number.isFinite(funnelDiameterMm) || funnelDiameterMm < 20 || funnelDiameterMm > 500)
    errors.push("Diamètre de l'entonnoir : entre 20 et 500 mm.");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: { sensorTopic, bucketMl, funnelDiameterMm } };
}

/** The Sowel device id: the Z2M friendly name, i.e. the last topic segment. */
export function deviceIdFromTopic(topic: string): string {
  const parts = topic.split("/");
  return parts[parts.length - 1];
}
