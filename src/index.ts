/**
 * Sowel Plugin: Rain gauge
 *
 * Tipping-bucket rain gauge read through a Zigbee door contact (Aqara & co.)
 * published by Zigbee2MQTT. Every contact flip is one bucket emptied; the plugin
 * turns flips into rain and exposes it with the Netatmo rain module's data
 * contract, so the user binds it to a Weather equipment like any rain gauge.
 */

import { MqttConnector } from "./mqtt-connector.js";
import { RainGaugeEngine, statePathIn } from "./rain-gauge-engine.js";
import type { DeviceManager, Logger } from "./rain-gauge-engine.js";
import { mmPerTip } from "./rain-counter.js";
import {
  DEFAULT_BUCKET_ML,
  DEFAULT_FUNNEL_RADIUS_MM,
  DEFAULT_SENSOR_TOPIC,
  deviceIdFromTopic,
  parseGaugeSettings,
} from "./settings.js";

interface SettingsManager {
  get(key: string): string | undefined;
}

interface EventBus {
  emit(event: unknown): void;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(
    device: Device,
    orderKeyOrDispatchConfig: string | Record<string, unknown>,
    value: unknown,
  ): Promise<void>;
}

const INTEGRATION_ID = "rain-gauge";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;

class RainGaugePlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Pluviomètre à bascule";
  readonly description = "Tipping-bucket rain gauge read through a Zigbee2MQTT door contact";
  readonly icon = "CloudRain";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private pluginDir: string;
  private mqtt: MqttConnector | null = null;
  private engine: RainGaugeEngine | null = null;
  private status: IntegrationStatus = "disconnected";

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
    this.pluginDir = deps.pluginDir;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.mqtt && !this.mqtt.isConnected()) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return this.getSetting("mqtt_url") !== undefined;
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      {
        key: "mqtt_url",
        label: "MQTT Broker URL",
        type: "text",
        required: true,
        placeholder: "mqtt://localhost:1883",
      },
      { key: "mqtt_username", label: "MQTT Username", type: "text", required: false },
      { key: "mqtt_password", label: "MQTT Password", type: "password", required: false },
      {
        key: "mqtt_client_id",
        label: "MQTT Client ID",
        type: "text",
        required: false,
        defaultValue: "sowel-rain-gauge",
      },
      {
        key: "sensor_topic",
        label: "Topic Zigbee2MQTT du capteur",
        type: "text",
        required: true,
        defaultValue: DEFAULT_SENSOR_TOPIC,
      },
      {
        key: "bucket_ml",
        label: "Volume d'un godet (ml)",
        type: "number",
        required: false,
        defaultValue: String(DEFAULT_BUCKET_ML),
      },
      {
        key: "funnel_radius_mm",
        label: "Rayon de l'entonnoir (mm)",
        type: "number",
        required: false,
        defaultValue: String(DEFAULT_FUNNEL_RADIUS_MM),
      },
    ];
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) {
      this.status = "not_configured";
      return;
    }

    const parsed = parseGaugeSettings((key) => this.getSetting(key));
    if (!parsed.ok) {
      this.status = "error";
      this.logger.error({ errors: parsed.errors }, "Invalid rain gauge settings — nothing is counted");
      return;
    }
    const { sensorTopic, bucketMl, funnelRadiusMm } = parsed.settings;

    const mqttUrl = this.getSetting("mqtt_url")!;
    const mqttUsername = this.getSetting("mqtt_username") || undefined;
    const mqttPassword = this.getSetting("mqtt_password") || undefined;
    // Random suffix avoids client_id collisions across restarts.
    const baseClientId = this.getSetting("mqtt_client_id") ?? "sowel-rain-gauge";
    const mqttClientId = `${baseClientId}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      this.mqtt = new MqttConnector(
        mqttUrl,
        { username: mqttUsername, password: mqttPassword, clientId: mqttClientId },
        this.eventBus,
        this.logger,
        INTEGRATION_ID,
      );
      await this.mqtt.connect();

      this.engine = new RainGaugeEngine(
        {
          integrationId: INTEGRATION_ID,
          sensorTopic,
          deviceId: deviceIdFromTopic(sensorTopic),
          mmPerTip: mmPerTip(bucketMl, funnelRadiusMm),
          statePath: statePathIn(this.pluginDir),
        },
        this.mqtt,
        this.deviceManager,
        this.logger,
      );
      this.engine.start();

      this.status = this.mqtt.isConnected() ? "connected" : "disconnected";
      this.logger.info("Rain gauge plugin started");
    } catch (err) {
      this.status = "error";
      this.logger.error({ err } as Record<string, unknown>, "Failed to start rain gauge plugin");
    }
  }

  async stop(): Promise<void> {
    this.engine?.stop();
    this.engine = null;
    if (this.mqtt) {
      await this.mqtt.disconnect();
      this.mqtt = null;
      this.status = "disconnected";
      this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
      this.logger.info("Rain gauge plugin stopped");
    }
  }

  async executeOrder(): Promise<void> {
    throw new Error("Rain gauge plugin is read-only and does not support orders");
  }

  private getSetting(key: string): string | undefined {
    return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`);
  }
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new RainGaugePlugin(deps);
}
