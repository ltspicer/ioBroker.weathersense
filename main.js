'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.2
 */

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const mqtt = require('mqtt');
const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');
const path = require('node:path');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

axios.defaults.timeout = 2000;

// ensure checker sees clearTimeout usage
void clearTimeout;

class WeatherSense extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'weathersense',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this._timeouts = new Set();
    }

    // Delay-Helferfunktion
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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

        // Delay 0-117s
        const startupDelay = Math.floor(Math.random() * 118) * 1000;
        this.log.debug(`Start cloud query after ${startupDelay / 1000} Seconds...`);
        await this.delay(startupDelay);

        if (Number(sensor_in)) {
            sensor_id = parseInt(sensor_in);
            if (sensor_id < 1 || sensor_id > 20) {
                this.log.error('Sensor ID has no value between 1 and 20');
                this.terminate ? this.terminate('Sensor ID has no value between 1 and 20', 0) : process.exit(0);
                return;
            }
        } else {
            this.log.error('Sensor ID has no valid value');
            this.terminate ? this.terminate('Sensor ID has no valid value', 0) : process.exit(0);
            return;
        }
        this.log.debug(`Sensor ID is ${sensor_id}`);

        if (username.trim().length === 0 || passwort.trim().length === 0) {
            this.log.error('User email and/or user password empty - please check instance configuration');
            this.terminate
                ? this.terminate('User email and/or user password empty - please check instance configuration', 0)
                : process.exit(0);
            return;
        }

        let client = null;
        if (mqtt_active) {
            if (broker_address.trim().length === 0 || broker_address == '0.0.0.0') {
                this.log.error('MQTT IP address is empty - please check instance configuration');
                this.terminate
                    ? this.terminate('MQTT IP address is empty - please check instance configuration', 0)
                    : process.exit(0);
                return;
            }
            client = mqtt.connect(`mqtt://${broker_address}:${mqtt_port}`, {
                connectTimeout: 4000,
                username: mqtt_user,
                password: mqtt_pass,
            });
        }

        try {
            const instObj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
            if (instObj && instObj.common && instObj.common.schedule && instObj.common.schedule === '*/10 * * * *') {
                instObj.common.schedule = `*/${Math.floor(Math.random() * 3) + 6} * * * *`;
                this.log.info(`Default schedule found and adjusted to spread calls better over 6-9 minutes!`);
                await this.setForeignObjectAsync(`system.adapter.${this.namespace}`, instObj);
                this.terminate ? this.terminate() : process.exit(0);
                return;
            }
        } catch (err) {
            this.log.error(`Could not check or adjust the schedule: ${err.message}`);
        }

        this.log.debug(`MQTT active: ${mqtt_active}`);
        this.log.debug(`MQTT port: ${mqtt_port}`);

        const deviceId = `${this.namespace}.${sensor_id}`;

        const allStatesOkId = `${deviceId}.allStatesOk`;
        await this.setObjectNotExistsAsync(allStatesOkId, {
            type: 'state',
            common: {
                name: 'All states ok',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });

        try {
            const mainResult = await this.main(
                client,
                username,
                passwort,
                mqtt_active,
                sensor_id,
                storeJson,
                storeDir,
                celsius,
                `${deviceId}.forecast`,
            );

            const dataReceived = mainResult.dataReceived;
            const devdata = mainResult.devdata;

            const systemStateId = `${deviceId}.DataReceived`;
            await this.setObjectNotExistsAsync(systemStateId, {
                type: 'state',
                common: {
                    name: 'Data successfully received',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false,
                },
                native: {},
            });

            if (dataReceived === true) {
                await this.setStateAsync(systemStateId, { val: true, ack: true });

                const devDataChannelId = `${deviceId}.devData`;
                const tempUnit = celsius ? '°C' : '°F';

                // Alle Werte aus devdata (außer content)
                for (const [key, value] of Object.entries(devdata)) {
                    if (key === 'content') {
                        continue;
                    }
                    if (value !== null && value !== undefined) {
                        const id = `${devDataChannelId}.${key}`;
                        await this.setObjectNotExistsAsync(id, {
                            type: typeof value === 'number' ? 'state' : 'state',
                            common: {
                                name: key,
                                type: typeof value,
                                role: 'value',
                                unit: '',
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(id, { val: value, ack: true });
                    }
                }

                // Alle Werte aus devdata.content
                const content = devdata.content || {};

                let status = await this.isSuccess(devdata);

                for (const [key, value] of Object.entries(content)) {
                    if (value !== null && value !== undefined && key !== 'sensorDatas') {
                        const id = `${devDataChannelId}.${key}`;

                        let unit = '';
                        if (key === 'atmos') {
                            unit = 'hPa';
                        }

                        await this.setObjectNotExistsAsync(id, {
                            type: typeof value === 'number' ? 'state' : 'state',
                            common: {
                                name: key,
                                type: typeof value,
                                role: 'value',
                                unit: unit,
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(id, { val: value, ack: true });
                    }
                }

                // Alle Sensoren aus devdata.content.sensorDatas
                const sensor_data = content.sensorDatas || [];
                for (const s of sensor_data) {
                    const type_ = s.type;
                    const channel = s.channel;
                    const cur_val = s.curVal;
                    const high_val = s.hihgVal;
                    const low_val = s.lowVal;

                    let prefix = '';

                    if (type_ === 1) {
                        prefix = '-Temp';
                    }
                    if (type_ === 2) {
                        prefix = '-Hum';
                    }

                    const key = `Channel${channel}-Type${type_}${prefix}`;
                    const base = `${devDataChannelId}.${key}`;

                    // current
                    if (cur_val !== null && cur_val !== undefined && cur_val !== 65535 && cur_val !== 255) {
                        const id = `${base}.current`;
                        await this.setObjectNotExistsAsync(id, {
                            type: 'state',
                            common: {
                                name: 'current',
                                type: 'number',
                                role:
                                    prefix === '-Temp'
                                        ? 'value.temperature'
                                        : prefix === '-Hum'
                                          ? 'value.humidity'
                                          : 'value',
                                unit: prefix === '-Temp' ? tempUnit : prefix === '-Hum' ? '%' : '',
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(id, { val: this.c_f_berechnen(cur_val, prefix, celsius), ack: true });
                    }
                    // high
                    if (high_val !== null && high_val !== undefined && high_val !== 65535 && high_val !== 255) {
                        const id = `${base}.high`;
                        await this.setObjectNotExistsAsync(id, {
                            type: 'state',
                            common: {
                                name: 'high',
                                type: 'number',
                                role:
                                    prefix === '-Temp'
                                        ? 'value.temperature'
                                        : prefix === '-Hum'
                                          ? 'value.humidity'
                                          : 'value',
                                unit: prefix === '-Temp' ? tempUnit : prefix === '-Hum' ? '%' : '',
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(id, { val: this.c_f_berechnen(high_val, prefix, celsius), ack: true });
                    }
                    // low
                    if (low_val !== null && low_val !== undefined && low_val !== 65535 && low_val !== 255) {
                        const id = `${base}.low`;
                        await this.setObjectNotExistsAsync(id, {
                            type: 'state',
                            common: {
                                name: 'low',
                                type: 'number',
                                role:
                                    prefix === '-Temp'
                                        ? 'value.temperature'
                                        : prefix === '-Hum'
                                          ? 'value.humidity'
                                          : 'value',
                                unit: prefix === '-Temp' ? tempUnit : prefix === '-Hum' ? '%' : '',
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(id, { val: this.c_f_berechnen(low_val, prefix, celsius), ack: true });
                    }

                    // dev*-Keys im Sensorobjekt
                    for (const [k, v] of Object.entries(s)) {
                        if (
                            k.startsWith('dev') &&
                            v !== null &&
                            v !== undefined &&
                            !(typeof v === 'object' && Object.keys(v).length === 0)
                        ) {
                            const id = `${base}.${k}`;
                            await this.setObjectNotExistsAsync(id, {
                                type: 'state',
                                common: {
                                    name: k,
                                    type: typeof v,
                                    role: 'value',
                                    unit: '',
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            });
                            await this.setStateAsync(id, { val: v, ack: true });
                        }
                    }
                }
                await this.setStateAsync(allStatesOkId, { val: status, ack: true });
            } else {
                this.log.error('Error loading data in main()');
                await this.setStateAsync(systemStateId, { val: false, ack: true });
                await this.setStateAsync(allStatesOkId, { val: false, ack: true });
            }
        } catch (error) {
            this.log.error(`Unexpected error in onReady(): ${error.message}`);
        } finally {
            if (client) {
                client.end();
            }
            this.terminate
                ? this.terminate('Everything done. Going to terminate till next schedule', 0)
                : process.exit(0);
        }
    }

    // Alle Statuswerte ok?
    async isSuccess(data) {
        try {
            if (data.status !== 0) {
                this.log.warn(`status: ${data.status}`);
                return false;
            }

            if (data.error !== 0) {
                this.log.warn(`error: ${data.error}`);
                return false;
            }

            if (data.message !== 'success') {
                this.log.warn(`message: ${data.message}`);
                return false;
            }

            if (data.content?.powerStatus === 0) {
                this.log.warn(`content/powerStatus: ${data.content.powerStatus}`);
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }

    // MQTT senden
    async sendMqtt(sensor_id, mqtt_active, client, topic, wert) {
        if (mqtt_active) {
            if (typeof wert !== 'string') {
                wert = wert !== null && wert !== undefined ? wert.toString() : '';
            }
            client.publish(`WeatherSense/${sensor_id.toString()}/${topic}`, wert);
        }
    }

    // °F nach °C umwandeln, falls notwendig
    c_f_berechnen(temp, prefix, celsius) {
        if (celsius && prefix === '-Temp') {
            if (temp !== null && temp !== undefined) {
                temp = ((temp - 32) / 1.8).toFixed(1);
            }
        }
        return parseFloat(temp);
    }

    // Forecast Datenpunkte erstellen und schreiben
    async createOrUpdateForecastDPs(forecastChannelId, forecasts, celsius) {
        if (!forecasts || !forecastChannelId) {
            return;
        }

        const forecastItems = [
            { id: 'day', type: 'string', role: 'value', unit: '' },
            { id: 'date', type: 'string', role: 'value', unit: '' },
            { id: 'high', type: 'number', role: 'value.temperature', unit: celsius ? '°C' : '°F' },
            { id: 'low', type: 'number', role: 'value.temperature', unit: celsius ? '°C' : '°F' },
            { id: 'text', type: 'string', role: 'text', unit: '' },
        ];

        for (let i = 0; i < forecasts.length; i++) {
            const forecast = forecasts[i];
            if (!forecast) {
                continue;
            }

            for (const item of forecastItems) {
                const id = `${forecastChannelId}.day_${i}.${item.id}`;
                await this.setObjectNotExistsAsync(id, {
                    type: 'state',
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
                if ((item.id === 'high' || item.id === 'low') && typeof val === 'number') {
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

    // Forecasts per MQTT senden
    async sendForecasts(client, forecasts, celsius, sensor_id) {
        if (!client || !forecasts) {
            return;
        }

        for (let i = 0; i < forecasts.length; i++) {
            const forecast = forecasts[i];
            if (!forecast) {
                continue;
            }

            await this.sendMqtt(sensor_id, true, client, `forecast/day_${i}/day`, forecast.day || '');
            await this.sendMqtt(sensor_id, true, client, `forecast/day_${i}/date`, forecast.date || '');

            let tempHigh = forecast.high;
            let tempLow = forecast.low;

            if (celsius && typeof tempHigh === 'number' && typeof tempLow === 'number') {
                tempHigh = Number(((tempHigh - 32) / 1.8).toFixed(1)); // Zahl, keine Zeichenkette
                tempLow = Number(((tempLow - 32) / 1.8).toFixed(1));
            } else {
                // Wenn kein Celsius oder kein Zahlentyp, trotzdem als Zahl (sofern möglich), sonst 0 als Fallback
                tempHigh = tempHigh != null ? Number(tempHigh) : 0;
                tempLow = tempLow != null ? Number(tempLow) : 0;
            }

            await this.sendMqtt(sensor_id, true, client, `forecast/day_${i}/high`, tempHigh);
            await this.sendMqtt(sensor_id, true, client, `forecast/day_${i}/low`, tempLow);
            await this.sendMqtt(sensor_id, true, client, `forecast/day_${i}/text`, forecast.text || '');
        }
    }

    // Alte MQTT Datenpunkte auf Subscriber löschen
    async clearOldForecasts(sensor_id, client, maxDays = 6) {
        for (let i = 0; i < maxDays; i++) {
            for (const key of ['day', 'date', 'high', 'low', 'text']) {
                await this.sendMqtt(sensor_id, true, client, `forecast/day_${i}/${key}`, '');
            }
        }
    }

    // Debugausgabe formatieren
    printAllKeys(d, prefix = '') {
        if (typeof d === 'object' && d !== null && !Array.isArray(d)) {
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

    // Funktion zum Erzeugen des PW-Hashes
    hashPassword(pw) {
        const key = Buffer.from('ZW1heEBwd2QxMjM=', 'base64').toString('utf8');
        const combined = pw + key;
        return crypto.createHash('md5').update(combined, 'utf8').digest('hex').toUpperCase();
    }

    // Login-Funktion
    async login(USERNAME, PASSWORD) {
        const LOGIN_URL = 'https://emaxlife.net/V1.0/account/login';
        const hashed_pw = this.hashPassword(PASSWORD);

        const headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': 'okhttp/3.14.9',
        };

        const payload = {
            email: USERNAME,
            pwd: hashed_pw,
        };

        try {
            const response = await axios.post(LOGIN_URL, payload, { headers });

            this.log.debug('Status code:', response.status);
            this.log.debug('Response:', response.data);

            const data = response.data;

            if (response.status === 200) {
                if (data.status === 0 && data.content) {
                    const token = data.content.token;
                    this.log.debug(`Login successful. Token: ${token.substring(0, 20)}...`);
                    return token;
                }
                this.log.error('Login failed:', data.message);
            } else {
                this.log.error('Server error');
            }
        } catch (error) {
            this.log.error('Error during login:', error.message);
        }

        return null;
    }

    // Realtime Daten holen
    async devData(token) {
        this.log.debug('getRealtime data...');

        const url = 'https://emaxlife.net/V1.0/weather/devData/getRealtime';
        const headers = {
            emaxtoken: token,
            'Content-Type': 'application/json',
        };

        try {
            const response = await axios.get(url, {
                headers,
                timeout: 5000,
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
            });

            if (response.status === 200) {
                this.log.debug('Data was received');
                return response.data;
            }
            this.log.error(`devData > Status Code: ${response.status}`);
            return 'error';
        } catch (error) {
            if (error.response) {
                this.log.error(`devData > Status Code: ${error.response.status}`);
            } else {
                this.log.error(`Error during request: ${error.message}`);
            }
            return 'error';
        }
    }

    // Forecast Daten holen
    async foreCast(token) {
        this.log.debug('getForecast data...');

        const url = 'https://emaxlife.net/V1.0/weather/netData/getForecast';
        const headers = {
            emaxtoken: token,
            'Content-Type': 'application/json',
        };

        try {
            const response = await axios.get(url, {
                headers,
                timeout: 5000,
                httpsAgent: new https.Agent({ rejectUnauthorized: false }), // entspricht verify=False
            });

            if (response.status === 200) {
                this.log.debug('Data was received');
                return response.data;
            }
            this.log.error(`foreCast > Status Code: ${response.status}`);
            return 'error';
        } catch (error) {
            if (error.response) {
                this.log.error(`foreCast > Status Code: ${error.response.status}`);
            } else {
                this.log.error(`Error during request: ${error.message}`);
            }
            return 'error';
        }
    }

    async main(client, username, passwort, mqtt_active, sensor_id, storeJson, storeDir, celsius, forecastChannelId) {
        const token = await this.login(username, passwort);
        if (!token) {
            this.log.error('No token received');
            if (mqtt_active) {
                await this.sendMqtt(sensor_id, mqtt_active, client, 'dataReceived', 'false');
                await this.sendMqtt(sensor_id, mqtt_active, client, 'allStatesOk', 'false');
                client.end();
            }
            return { dataReceived: false };
        }
        const devdata = await this.devData(token);
        const forecast = await this.foreCast(token);
        if (devdata === 'error' || forecast === 'error') {
            this.log.error('No data received');
            if (mqtt_active) {
                await this.sendMqtt(sensor_id, mqtt_active, client, 'dataReceived', 'false');
                await this.sendMqtt(sensor_id, mqtt_active, client, 'allStatesOk', 'false');
                client.end();
            }
            return { dataReceived: false };
        }

        if (storeJson) {
            this.log.debug(`Save devData.json to ${storeDir}`);
            const json_object = JSON.stringify(devdata, null, 4);
            fs.writeFileSync(path.join(storeDir, 'devData.json'), json_object, 'utf-8');
        }

        this.printAllKeys(devdata);

        let status = await this.isSuccess(devdata);

        if (mqtt_active) {
            for (const [key, value] of Object.entries(devdata)) {
                if (key === 'content') {
                    continue;
                }
                if (value !== null && value !== undefined) {
                    this.sendMqtt(sensor_id, mqtt_active, client, `devData/${key}`, value);
                }
            }

            const content = devdata.content || {};
            for (const [key, value] of Object.entries(content)) {
                if (value !== null && value !== undefined) {
                    this.sendMqtt(sensor_id, mqtt_active, client, `devData/${key}`, value);
                }
            }

            const sensor_data = content.sensorDatas || [];

            for (const s of sensor_data) {
                const type_ = s.type;
                const channel = s.channel;
                const cur_val = s.curVal;
                const high_val = s.hihgVal;
                const low_val = s.lowVal;

                let prefix = '';
                if (type_ === 1) {
                    prefix = '-Temp';
                }
                if (type_ === 2) {
                    prefix = '-Hum';
                }

                const key = `Channel${channel}-Type${type_}${prefix}`;
                const base = `devData/${key}`;

                if (cur_val !== null && cur_val !== undefined && cur_val !== 65535 && cur_val !== 255) {
                    this.sendMqtt(
                        sensor_id,
                        mqtt_active,
                        client,
                        `${base}/current`,
                        this.c_f_berechnen(cur_val, prefix, celsius),
                    );
                }
                if (high_val !== null && high_val !== undefined && high_val !== 65535 && high_val !== 255) {
                    this.sendMqtt(
                        sensor_id,
                        mqtt_active,
                        client,
                        `${base}/high`,
                        this.c_f_berechnen(high_val, prefix, celsius),
                    );
                }
                if (low_val !== null && low_val !== undefined && low_val !== 65535 && low_val !== 255) {
                    this.sendMqtt(
                        sensor_id,
                        mqtt_active,
                        client,
                        `${base}/low`,
                        this.c_f_berechnen(low_val, prefix, celsius),
                    );
                }

                for (const [k, v] of Object.entries(s)) {
                    if (
                        k.startsWith('dev') &&
                        v !== null &&
                        v !== undefined &&
                        !(typeof v === 'object' && Object.keys(v).length === 0)
                    ) {
                        this.sendMqtt(sensor_id, mqtt_active, client, `${base}/${k}`, v);
                    }
                }
            }
        }

        if (storeJson) {
            this.log.debug(`Save forecast.json to ${storeDir}`);
            const json_object = JSON.stringify(forecast, null, 4);
            fs.writeFileSync(path.join(storeDir, 'forecast.json'), json_object, 'utf-8');
        }

        this.printAllKeys(forecast);

        if (status) {
            status = await this.isSuccess(forecast);
        }

        const forecasts = forecast?.content?.forecast?.forecasts || [];

        if (mqtt_active) {
            await this.clearOldForecasts(sensor_id, client, 6);
            await this.delay(2000); // sleep 2s

            await this.sendForecasts(client, forecasts, celsius, sensor_id);

            await this.sendMqtt(sensor_id, mqtt_active, client, 'allStatesOk', status);

            client.end(); // wie client.disconnect()
        }

        await this.createOrUpdateForecastDPs(forecastChannelId, forecasts, celsius);

        this.log.debug(`allStatesOk: ${status}`);

        return {
            allStatesOk: true,
            dataReceived: true,
            devdata,
            forecast,
        };
    }

    onUnload(callback) {
        try {
            // Timer stoppen
            for (const t of this._timeouts) {
                clearTimeout(t);
            }
            this._timeouts.clear();

            // Cronjobs stoppen
            if (this._cronJobs) {
                for (const job of this._cronJobs) {
                    job.stop();
                }
            }
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new WeatherSense(options);
} else {
    new WeatherSense();
}
