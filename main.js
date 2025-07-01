"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.2
 */

const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const mqtt = require("mqtt");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const path = require("path");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

axios.defaults.timeout = 2000;

class WeatherSense extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: "weathersense",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    async onReady() {
        const username = this.config.username;
        const passwort = this.config.passwort;
        const broker_address = this.config.broker_address;
        const mqtt_active = this.config.mqtt_active;
        const celsius = this.config.celsius;
        const mqtt_user = this.config.mqtt_user;
        const mqtt_pass = this.config.mqtt_pass;
        const mqtt_port = this.config.mqtt_port;
        const sensor_in = this.config.sensor_id;
        let sensor_id = 1;
        const storeJson = this.config.storeJson;
        const storeDir = this.config.storeDir;

        if (Number(sensor_in)) {
            sensor_id = parseInt(sensor_in);
            if (sensor_id < 1 || sensor_id > 20) {
                this.log.error("Sensor ID has no value between 1 and 20");
                this.terminate ? this.terminate("Sensor ID has no value between 1 and 20", 0) : process.exit(0);
                return;
            }
        } else {
            this.log.error("Sensor ID has no valid value");
            this.terminate ? this.terminate("Sensor ID has no valid value", 0) : process.exit(0);
            return;
        }
        this.log.debug("Sensor ID is " + sensor_id);

        if (username.trim().length === 0 || passwort.trim().length === 0) {
            this.log.error("User email and/or user password empty - please check instance configuration");
            this.terminate ? this.terminate("User email and/or user password empty - please check instance configuration", 0) : process.exit(0);
            return;
        }

        let client = null;
        if (mqtt_active) {
            if (broker_address.trim().length === 0 || broker_address == "0.0.0.0") {
                this.log.error("MQTT IP address is empty - please check instance configuration");
                this.terminate ? this.terminate("MQTT IP address is empty - please check instance configuration", 0) : process.exit(0);
                return;
            }
            client = mqtt.connect(`mqtt://${broker_address}:${mqtt_port}`, {
                connectTimeout: 4000,
                username: mqtt_user,
                password: mqtt_pass
            });
        }

        try {
            const instObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (instObj && instObj.common && instObj.common.schedule && instObj.common.schedule === "*/5 * * * *") {
                instObj.common.schedule = `*/${Math.floor(Math.random() * 6)} * * * *`;
                this.log.info(`Default schedule found and adjusted to spread calls better over the full hour!`);
                await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instObj);
                this.terminate ? this.terminate() : process.exit(0);
                return;
            }
        } catch (err) {
            this.log.error(`Could not check or adjust the schedule: ${err.message}`);
        }

        this.log.debug("MQTT active: " + mqtt_active);
        this.log.debug("MQTT port: " + mqtt_port);

        // Forecast Channel anlegen
        const forecastChannelId = `${sensor_id}.forecast`;

        try {
            const dataReceived = await this.main(client, username, passwort, mqtt_active, sensor_id, storeJson, storeDir, celsius, forecastChannelId);

            const systemStateId = `${sensor_id}.DataReceived`;
            await this.setObjectNotExistsAsync(systemStateId, {
                type: "state",
                common: {
                    name: "Data successfully received",
                    type: "boolean",
                    role: "indicator",
                    read: true,
                    write: false
                },
                native: {},
            });

            if (dataReceived === true) {

                await this.setStateAsync(systemStateId, { val: true, ack: true });

                // DevData Channel anlegen
                const devDataChannelId = `${sensor_id}.devdata`;
                await this.setObjectNotExistsAsync(devDataChannelId, {
                    type: "channel",
                    common: { name: "DevData" },
                    native: {},
                });

                await this.setObjectNotExistsAsync(forecastChannelId, {
                    type: "channel",
                    common: { name: "Forecast" },
                    native: {},
                });

                const tempUnit = celsius ? "°C" : "°F";
                this.log.debug(`Unit: ${tempUnit}`);

                // Bekannte Items
                const fixedItems = [
                    { id: "atmospheric_pressure", type: "number", role: "value.pressure", unit: "hPa" },
                    { id: "indoor_temp", type: "number", role: "value.temperature", unit: tempUnit },
                    { id: "indoor_humidity", type: "number", role: "value.humidity", unit: "%" },
                    { id: "outdoor_temp", type: "number", role: "value.temperature", unit: tempUnit },
                    { id: "outdoor_humidity", type: "number", role: "value.humidity", unit: "%" },
                ];

                // Zuerst die festen Items anlegen und setzen
                for (const item of fixedItems) {
                    const id = `${devDataChannelId}.${item.id}`;
                    await this.setObjectNotExistsAsync(id, {
                        type: "state",
                        common: {
                            name: item.id,
                            type: item.type,
                            role: item.role,
                            unit: item.unit,
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    const val = this.contentDevData ? this.contentDevData[item.id] : null;
                    if (val != null) {
                        await this.setStateAsync(id, { val: val, ack: true });
                    }
                }

                // Jetzt alle zusätzlichen dynamischen Keys aus this.contentDevData durchgehen
                for (const key of Object.keys(this.contentDevData || {})) {
                    // Schon behandelt?
                    if (fixedItems.find(item => item.id === key)) continue;

                    const val = this.contentDevData[key];

                    // Typ und Rolle
                    const common = {
                        name: key,
                        type: typeof val === "number" ? "number" : "string",
                        role: "value",
                        unit: "",
                        read: true,
                        write: false,
                    };

                    if (key.includes("temp")) {
                        common.role = "value.temperature";
                        common.unit = tempUnit;
                    } else if (key.includes("humidity")) {
                        common.role = "value.humidity";
                        common.unit = "%";
                    } else if (key.includes("pressure")) {
                        common.role = "value.pressure";
                        common.unit = "hPa";
                    }

                    const id = `${devDataChannelId}.${key}`;

                    await this.setObjectNotExistsAsync(id, {
                        type: "state",
                        common,
                        native: {},
                    });

                    await this.setStateAsync(id, { val: val, ack: true });
                }
            } else {
                this.log.error("Error loading data in main()");
                await this.setStateAsync(systemStateId, { val: false, ack: true });
            }
        } catch (error) {
            this.log.error("Unexpected error in onReady(): " + error.message);
        } finally {
            if (client) {
                client.end();
            }
            this.terminate ? this.terminate("Everything done. Going to terminate till next schedule", 0) : process.exit(0);
        }
    }

    async sendMqtt(sensor_id, mqtt_active, client, topic, wert) {
        if (mqtt_active) {
            // Wenn wert nicht String ist, in String umwandeln (auch null und undefined abfangen)
            if (typeof wert !== "string") {
                wert = wert !== null && wert !== undefined ? wert.toString() : "";
            }
            client.publish("WEATHERSENSE/" + sensor_id.toString() + "/" + topic, wert);
        }
    }

    async createOrUpdateForecastDPs(forecastChannelId, forecasts, celsius) {
        if (!forecasts || !forecastChannelId) return;

        // Struktur der Forecast-Items pro Tag
        const forecastItems = [
            { id: "day", type: "string", role: "value", unit: "" },
            { id: "date", type: "string", role: "value", unit: "" },
            { id: "high", type: "number", role: "value.temperature", unit: celsius ? "°C" : "°F" },
            { id: "low", type: "number", role: "value.temperature", unit: celsius ? "°C" : "°F" },
            { id: "text", type: "string", role: "text", unit: "" },
        ];

        for (let i = 0; i < forecasts.length; i++) {
            const forecast = forecasts[i];
            if (!forecast) continue;

            for (const item of forecastItems) {
                const id = `${forecastChannelId}.${i}.${item.id}`;
                await this.setObjectNotExistsAsync(id, {
                    type: "state",
                    common: {
                        name: item.id,
                        type: item.type,
                        role: item.role,
                        unit: item.unit,
                        read: true,
                        write: false,
                    },
                    native: {},
                });

                let val = forecast[item.id];
                if ((item.id === "high" || item.id === "low") && typeof val === "number") {
                    if (celsius) {
                        val = Number(((val - 32) / 1.8).toFixed(1));
                    } else {
                        val = Number(val);
                    }
                }

                if (val != null) {
                    await this.setStateAsync(id, { val: val, ack: true });
                }
            }
        }
    }

    async sendForecasts(client, forecasts, celsius, sensor_id) {
        if (!client || !forecasts) return;

        for (let i = 0; i < forecasts.length; i++) {
            const forecast = forecasts[i];
            if (!forecast) continue;

            await this.sendMqtt(sensor_id, true, client, `forecast/${i}/day`, forecast.day || "");
            await this.sendMqtt(sensor_id, true, client, `forecast/${i}/date`, forecast.date || "");

            let tempHigh = forecast.high;
            let tempLow = forecast.low;

            if (celsius && typeof tempHigh === "number" && typeof tempLow === "number") {
                tempHigh = Number(((tempHigh - 32) / 1.8).toFixed(1));  // Zahl, keine Zeichenkette
                tempLow = Number(((tempLow - 32) / 1.8).toFixed(1));
            } else {
                // Wenn kein Celsius oder kein Zahlentyp, trotzdem als Zahl (sofern möglich), sonst 0 als Fallback
                tempHigh = tempHigh != null ? Number(tempHigh) : 0;
                tempLow = tempLow != null ? Number(tempLow) : 0;
            }

            await this.sendMqtt(sensor_id, true, client, `forecast/${i}/high`, tempHigh);
            await this.sendMqtt(sensor_id, true, client, `forecast/${i}/low`, tempLow);
            await this.sendMqtt(sensor_id, true, client, `forecast/${i}/text`, forecast.text || "");
        }
    }

    async clearOldForecasts(sensor_id, client, maxDays = 6) {
        for (let i = 0; i < maxDays; i++) {
            for (const key of ["day", "date", "high", "low", "text"]) {
                await this.sendMqtt(sensor_id, true, client, `forecast/${i}/${key}`, "");
            }
        }
    }

    printAllKeys(d, prefix = "") {
        if (typeof d === "object" && d !== null && !Array.isArray(d)) {
            for (const [k, v] of Object.entries(d)) {
                this.printAllKeys(v, `${prefix}${k}/`);
            }
        } else if (Array.isArray(d)) {
            d.forEach((item, i) => {
                this.printAllKeys(item, `${prefix}${i}/`);
            });
        } else {
            this.log.debug(`${prefix}: ${d}`);
        }
    }

    findValue(sensor_data, type, channel) {
        const entry = sensor_data.find(item => item.type === type && item.channel === channel);
        return entry ? entry.curVal : null;
    }


    // Funktion zum Erzeugen des MD5-Hashes
    hashPassword(pw, key) {
        const combined = pw + key;
        return crypto.createHash("md5").update(combined, "utf8").digest("hex").toUpperCase();
    }

    // Login-Funktion
    async login(USERNAME, PASSWORD) {
        const MD5_KEY = "emax@pwd123";
        const LOGIN_URL = "https://47.52.149.125/V1.0/account/login";
        const hashed_pw = this.hashPassword(PASSWORD, MD5_KEY);

        const headers = {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "okhttp/3.14.9"
        };

        const payload = {
            email: USERNAME,
            pwd: hashed_pw
        };

        try {
            const response = await axios.post(LOGIN_URL, payload, { headers });

            this.log.debug("Status code:", response.status);
            this.log.debug("Response:", response.data);

            const data = response.data;

            if (response.status === 200) {
                if (data.status === 0 && data.content) {
                    const token = data.content.token;
                    this.log.debug("Login successful. Token: " + token.substring(0, 20) + "...");
                    return token;
                } else {
                    this.log.error("Login failed:", data.message);
                }
            } else {
                this.log.error("Server error");
            }
        } catch (error) {
            this.log.error("Error during login:", error.message);
        }

        return null;
    }

    async devData(token) {
        // Realtime Daten holen
        this.log.debug("getRealtime data...");

        const url = "https://emaxlife.net/V1.0/weather/devData/getRealtime";
        const headers = {
            "emaxtoken": token,
            "Content-Type": "application/json"
        };

        try {
            const response = await axios.get(url, {
                headers,
                timeout: 5000,
                httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false })
            });

            if (response.status === 200) {
                this.log.debug("Data was received");
                return response.data;
            } else {
                this.log.error(`devData > Status Code: ${response.status}`);
                return "error";
            }
        } catch (error) {
            if (error.response) {
                this.log.error(`devData > Status Code: ${error.response.status}`);
            } else {
                this.log.error(`Error during request: ${error.message}`);
            }
            return "error";
        }
    }

    async foreCast(token) {
        // Forecast holen
        this.log.debug("getForecast data...");

        const url = "https://emaxlife.net/V1.0/weather/netData/getForecast";
        const headers = {
            "emaxtoken": token,
            "Content-Type": "application/json"
        };

        try {
            const response = await axios.get(url, {
                headers,
                timeout: 5000,
                httpsAgent: new https.Agent({ rejectUnauthorized: false }) // entspricht verify=False
            });

            if (response.status === 200) {
                this.log.debug("Data was received");
                return response.data;
            } else {
                this.log.error(`foreCast > Status Code: ${response.status}`);
                return "error";
            }
        } catch (error) {
            if (error.response) {
                this.log.error(`foreCast > Status Code: ${error.response.status}`);
            } else {
                this.log.error(`Error during request: ${error.message}`);
            }
            return "error";
        }
    }

    async main(client, username, passwort, mqtt_active, sensor_id, storeJson, storeDir, celsius, forecastChannelId) {
        const token = await this.login(username, passwort);
        if (!token) {
            this.log.error("No token received");
            if (mqtt_active) {
                await this.sendMqtt(sensor_id, mqtt_active, client, "dataReceived", "false");
                client.end();
            }
            return false;
        }
        const devdata = await this.devData(token);
        const forecast = await this.foreCast(token);
        if (devdata === "error" || forecast === "error") {
            this.log.error("No data received");
            if (mqtt_active) {
                await this.sendMqtt(sensor_id, mqtt_active, client, "dataReceived", "false");
                client.end();
            }
            return false;
        }

        if (storeJson) {
            this.log.debug("Save devData.json to " + storeDir);
            const json_object = JSON.stringify(devdata, null, 4);
            fs.writeFileSync(path.join(storeDir, "devData.json"), json_object, "utf-8");
        }

        this.log.debug("devData JSON:");
        this.printAllKeys(devdata);

        const content = devdata?.content || {};
        const sensor_data = content.sensorDatas || [];

        const luftdruck = content.atmos;
        let temp_innen = this.findValue(sensor_data, 1, 0);
        const feuchte_innen = this.findValue(sensor_data, 2, 0);
        let temp_aussen = this.findValue(sensor_data, 1, 2);
        const feuchte_aussen = this.findValue(sensor_data, 2, 2);

        const skipCombinations = new Set(["1_0", "1_2", "2_0", "2_2"]);

        if (celsius) {
            if (temp_innen != null) temp_innen = ((temp_innen - 32) / 1.8).toFixed(1);
            if (temp_aussen != null) temp_aussen = ((temp_aussen - 32) / 1.8).toFixed(1);
        }

        if (mqtt_active) {
            const error_code = devdata.error;

            if (error_code != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/error", error_code);
            if (content.devTime) this.sendMqtt(sensor_id, mqtt_active, client, "devData/devtime", content.devTime);
            if (content.updateTime) this.sendMqtt(sensor_id, mqtt_active, client, "devData/updateTime", content.updateTime);
            if (content.deviceMac) this.sendMqtt(sensor_id, mqtt_active, client, "devData/deviceMac", content.deviceMac);
            if (content.devTimezone != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/devTimezone", content.devTimezone);
            if (content.wirelessStatus != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/wirelessStatus", content.wirelessStatus);
            if (content.powerStatus != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/powerStatus", content.powerStatus);
            if (content.weatherStatus != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/weatherStatus", content.weatherStatus);
            if (luftdruck != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/atmospheric_pressure", luftdruck);
            if (temp_innen != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/indoor_temp", temp_innen);
            if (feuchte_innen != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/indoor_humidity", feuchte_innen);
            if (temp_aussen != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/outdoor_temp", temp_aussen);
            if (feuchte_aussen != null) this.sendMqtt(sensor_id, mqtt_active, client, "devData/outdoor_humidity", feuchte_aussen);

            // >>> Zusätzliche dynamische Sensoren ausgeben:
            for (const s of sensor_data) {
                const { type, channel, curVal, hihgVal, lowVal, ...rest } = s;
                const key = `${type}_${channel}`;
                if (skipCombinations.has(key)) continue;
                const base = `devData/sensor_${type}_${channel}`;

                if (curVal != null && curVal !== 65535) {
                    await this.sendMqtt(sensor_id, mqtt_active, client, `${base}/current`, curVal);
                }
                if (hihgVal != null && hihgVal !== 65535) {
                    await this.sendMqtt(sensor_id, mqtt_active, client, `${base}/high`, hihgVal);
                }
                if (lowVal != null && lowVal !== 65535) {
                    await this.sendMqtt(sensor_id, mqtt_active, client, `${base}/low`, lowVal);
                }

                for (const [nestedKey, nestedVal] of Object.entries(rest)) {
                    if (nestedVal && typeof nestedVal === "object") {
                        const entries = Object.entries(nestedVal);

                        if (entries.length === 0) {
                            // Leeres Objekt → Platzhalter senden
                            const topic = `${base}/${nestedKey}`;
                            await this.sendMqtt(sensor_id, mqtt_active, client, topic, "n/a");
                            this.log.debug(`Send MQTT: ${topic}: n/a (empty object)`);
                        } else {
                            // Inhaltliches Objekt → Einzeldaten senden
                            for (const [k, v] of entries) {
                                if (v != null) {
                                    const topic = `${base}/${nestedKey}/${k}`;
                                    await this.sendMqtt(sensor_id, mqtt_active, client, topic, v);
                                    this.log.debug(`Send MQTT: ${topic}: ${v}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Basiswerte setzen
        this.contentDevData = {
            atmospheric_pressure: luftdruck,
            indoor_temp: temp_innen,
            indoor_humidity: feuchte_innen,
            outdoor_temp: temp_aussen,
            outdoor_humidity: feuchte_aussen,
        };

        // Zusätzliche Sensoren ergänzen (alle type/channel Kombinationen)
        for (const s of sensor_data) {
            const { type, channel, curVal, hihgVal, lowVal, ...rest } = s;
            const key = `${type}_${channel}`;
            if (skipCombinations.has(key)) continue;  // Überspringen, wenn schon bekannt

            const keyBase = `sensor_${type}_${channel}`;

            if (curVal != null && curVal !== 65535) this.contentDevData[`${keyBase}_current`] = curVal;
            if (hihgVal != null && hihgVal !== 65535) this.contentDevData[`${keyBase}_high`] = hihgVal;
            if (lowVal != null && lowVal !== 65535) this.contentDevData[`${keyBase}_low`] = lowVal;

            for (const [k, v] of Object.entries(rest)) {
                if (v && typeof v === "object" && Object.keys(v).length === 0) {
                    this.contentDevData[`${keyBase}_${k}`] = "n/a";
                } else if (v != null) {
                    this.contentDevData[`${keyBase}_${k}`] = v;
                }
            }
        }

        if (storeJson) {
            this.log.debug("Save forecast.json to " + storeDir);
            const json_object = JSON.stringify(forecast, null, 4);
            fs.writeFileSync(path.join(storeDir, "forecast.json"), json_object, "utf-8");
        }

        this.printAllKeys(forecast);

        const forecasts = forecast?.content?.forecast?.forecasts || [];

        if (mqtt_active) {
            await this.clearOldForecasts(sensor_id, client, 6);
            await new Promise(r => setTimeout(r, 2000)); // sleep 2s

            await this.sendForecasts(client, forecasts, celsius, sensor_id);

            client.end(); // wie client.disconnect()
        }

        await this.createOrUpdateForecastDPs(forecastChannelId, forecasts, celsius);

        return true;
    }

    onUnload(callback) {
        try {
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new WeatherSense(options);
} else {
    new WeatherSense();
}
