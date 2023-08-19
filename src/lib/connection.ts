import { ComponentType, DeviceCommand } from "./type.ts";
import * as mqtt from "npm:mqtt@5";
import { Node } from "./node.ts";
import { EventEmitter } from "node:events";
import { localStorage } from "./storage.ts";
import { Property, PropertyArgs } from "./property.ts";
import { Buffer } from "node:buffer";
import connect from "./mqtt.ts"

export enum DeviceStatus {
  disconnected = "disconnected",
  lost = "lost",
  error = "error",
  alert = "alert",
  sleeping = "sleeping",
  restarting = "restarting",
  ready = "ready",
  init = "init",
  paired = "paired",
}

function logger(...args: any) {
  if (Deno.env.get("MODE") != "test") console.log(...args);
}
interface store {
  apiKey: string;
}

export class Platform extends EventEmitter {
  deviceId: string;
  deviceName: string;
  meta: null | store = null;
  userName: string;
  client: mqtt.MqttClient;
  prefix = "prefix";
  nodes: Node[] = [];
  sensorCnt = -1;
  status: DeviceStatus = DeviceStatus.lost;
  mqttHost: string;
  mqttPort: number;

  constructor(
    deviceId: string,
    userName: string,
    deviceName: string,
    mqttHost: string,
    mqttPort: number,
  ) {
    super();
    this.deviceId = Deno.env.get("DEVICE_ID") || deviceId;
    this.userName = Deno.env.get("USERNAME") || userName;
    this.deviceName = deviceName;
    this.mqttHost = mqttHost;
    this.mqttPort = mqttPort;
    // temporary fix
    this.client = undefined as any;

    const storedItem = localStorage.getItem(this.deviceId);
    if (storedItem) this.meta = JSON.parse(storedItem);
  }

  init = () => {
    if (!this.isPaired()) return this.connectPairing();
    return this.connect();
  };

  isPaired = () => {
    return this.meta;
  };

  forgot = () => {
    this.meta = null;
    this.prefix = "prefix";
    localStorage.removeItem(this.deviceId);
  };

  createMqttInstance = (userName: string, password: string, applyListeners: (client: mqtt.MqttClient) => void) => {
    if (this.client) this.client.end(true);

    logger(`connecting as to prefix ${this.mqttHost}:${this.mqttPort}, username ${userName}, password=${password.replace(/./g, "*")}`);

    const config: mqtt.IClientOptions = {
      username: userName,
      password: password,
      port: this.mqttPort,
      rejectUnauthorized: false,
      keepalive: 10,
      will: {
        topic: `${this.getDevicePrefix()}/$state`,
        payload: Buffer.from(DeviceStatus.lost, "utf-8"),
        retain: true,
        qos: 1,
      },
    }

    connect(this.mqttHost, config, applyListeners)

    const client = mqtt.connect(this.mqttHost, {
      username: userName,
      password: password,
      port: this.mqttPort,
      rejectUnauthorized: false,
      keepalive: 20,
      will: {
        topic: "v2/" + this.userName + "/" + this.deviceId + "/$state",
        payload: Buffer.from(DeviceStatus.lost, "utf-8"),
        retain: true,
        qos: 1,
      },
    })

    this.client = client;
  }

  connect = () => {
    if (this.meta === null) {
      logger("cant connect without apiKey");
      return;
    }

    this.prefix = `v2/${this.userName}`;

    const applyListeners = (client: mqtt.MqttClient) => {
      this.client = client;
      this.publishStatus(DeviceStatus.init, client);

      logger("connecting as paired device");
      // client.subscribe("v2/device/" + this.deviceId + "/apiKey");
      client.subscribe(`${this.getDevicePrefix()}/$cmd/set`);

      this.advertise();

      this.nodes.forEach((node) => {
        node.subscribe(this.getDevicePrefix(), client)
        node.updateClient(this.getDevicePrefix(), client)
      });

      client.on("message", (topic, data) => {
        const message = data.toString();
        logger("message", topic, message);
        if (topic === `${this.getDevicePrefix()}/$cmd/set`) {
          if (message === DeviceCommand.restart) {
            logger("Reseting...");
            client.end();
            this.connect();
          } else if (message === DeviceCommand.reset) {
            logger("Restarting...");
            client.end();
            this.forgot();
            this.connectPairing();
          }
        }

      });

      client.on("error", (err: any) => {
        if (err.code === 4) {
          // Invalid login
          logger("Invalid userName/password, forgeting apiKey");

          if (Deno.env.get("NODE_ENV") !== "production") {
            client.end();
            this.forgot();
            this.connectPairing();
          }
        } else logger("error2", err);
      });

      client.on("connect", () => {
        this.emit("connect", client);
      });

      this.publishStatus(DeviceStatus.ready, client);
    }

    this.createMqttInstance(`device=${this.userName}/${this.deviceId}`, this.meta.apiKey, applyListeners)
  };

  addNode = (nodeId: string, name: string, componentType: ComponentType) => {
    const node = new Node({ nodeId, name, componentType });
    this.nodes.push(node);
    return node;
  };

  addSensor = (args: PropertyArgs) => {
    const node = this.addNode(
      "sensor" + ++this.sensorCnt,
      args.name,
      ComponentType.sensor,
    );
    node.addProperty(args);
  };

  publishStatus = (status: DeviceStatus, client: mqtt.MqttClient) => {
    if (!client.disconnecting || !client.disconnected)
      this.client.publish(`${this.getDevicePrefix()}/$state`, status)
  };

  getDevicePrefix = () => `${this.prefix}/${this.deviceId}`;

  /**
   * Advertise all features, nodes and properties
   */
  advertise = () => {
    const devicePrefix = this.getDevicePrefix();
    this.client.publish(`${devicePrefix}/$name`, this.deviceName);
    this.client.publish(`${devicePrefix}/$realm`, this.userName);
    this.client.publish(`${devicePrefix}/$nodes`, this.nodes.map((node) => node.nodeId).join());

    this.nodes.forEach(node => node.advertise(devicePrefix, this.client));
  }

  connectPairing = () => {
    this.prefix = "prefix";
    const applyListeners = (client: mqtt.MqttClient) => {
      this.client = client;
      this.publishStatus(DeviceStatus.init, client);

      const devicePrefix = this.getDevicePrefix();
      client.subscribe(`${devicePrefix}/$config/apiKey/set`);
      client.subscribe(`${devicePrefix}/$cmd/set`);

      this.advertise()

      this.nodes.forEach((node) => {
        // Only allow publishing values, do not allow setting
        node.updateClient(this.getDevicePrefix(), client)
      });

      logger("meta", this.meta);

      client.on("message", (topic, message) => {
        logger("message", topic, message.toString());

        if (this.getDevicePrefix() + "/$config/apiKey/set") {
          this.meta = { apiKey: message.toString() };
          localStorage.setItem(this.deviceId, JSON.stringify(this.meta));
          logger("GOT apiKey -> reconect");

          this.publishStatus(DeviceStatus.paired, client);
          this.publishStatus(DeviceStatus.disconnected, client);
          client.end();
          this.connect();
        }
      });

      this.publishStatus(DeviceStatus.ready, client);
    }

    this.createMqttInstance(`guest=${this.deviceId}`, this.userName, applyListeners)

    // this.client = mqtt.connect(this.mqttHost, {
    //   username: "guest=" + this.deviceId,
    //   password: this.userName,
    //   port: this.mqttPort,
    //   rejectUnauthorized: false,
    //   will: {
    //     topic: `${this.getDevicePrefix()}/$state`,
    //     payload: new Buffer(new TextEncoder().encode(DeviceStatus.lost)),
    //     retain: true,
    //     qos: 1,
    //   }
    // });
  };

  publishPropertyData = (
    propertyId: string,
    value: string | ((node: Node, property: Property) => string),
  ) => {
    const node = this.nodes.find(({ properties }) =>
      properties.some((prop) => prop.propertyId === propertyId)
    );
    const property = node?.properties.find((prop) =>
      prop.propertyId === propertyId
    );
    if (!node || !property) {
      return logger(`unable to locate node with property ${propertyId}`);
    }

    if (!this.client) return logger("Not connected");

    const finalValue = typeof value === "function"
      ? value(node, property)
      : value;

    property.setValue(finalValue)
  };

  disconnect = () => {
    this.publishStatus(DeviceStatus.disconnected, this.client);
    this.client.end()
  };
}
