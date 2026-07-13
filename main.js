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
const agent = new https.Agent({
    rejectUnauthorized: false,
});

axios.defaults.httpsAgent = agent;
axios.defaults.timeout = 3000;

// ensure checker sees clearTimeout usage
void clearTimeout;

function isInvalidValue(value, type_) {
    if (value === null || value === undefined) {
        return true;
    }

    if (value === 65535) {
        return true;
    }

    if (type_ === 1 || type_ === 2) {
        if (value === 255) {
            return true;
        }
    }

    return false;
}

function pressureToSeaLevel(pressure_hPa, altitude_masl) {
    const tempLapse = 0.0065;
    const temp0 = 288.15;
    const exponent = 5.255;

    const factor = 1 - (tempLapse * altitude_masl) / temp0;

    if (factor <= 0) {
        return pressure_hPa;
    }

    const seaLevelPressure = pressure_hPa * Math.pow(factor, -exponent);

    const rounded = Math.round(seaLevelPressure);

    return rounded;
}

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
        return new Promise(resolve => this.setTimeout(resolve, ms));
    }

    async onReady() {
        const username = this.config.username;
        const passwort = this.config.passwort;
        const broker_address = this.config.broker_address;
        const mqtt_active = this.config.mqtt_active;
        const celsius = this.config.celsius;
        const rain_unit_mm = this.config.rain_unit;
        const wind_unit_kmh = this.config.wind_unit;
        const altitude_masl_in = this.config.altitude_masl;
        let altitude_masl = 0;
        const mqtt_user = this.config.mqtt_user;
        const mqtt_pass = this.config.mqtt_pass;
        const mqtt_port = this.config.mqtt_port;
        const sensor_in = this.config.sensor_id;
        let sensor_id = 1;
        const storeJson = this.config.storeJson;
        const storeDir = this.config.storeDir;
        const inversePowerStatus = this.config.inversePowerStatus;

        // Delay 0-55s
        const startupDelay = Math.floor(Math.random() * 56) * 1000;
        this.log.info(`Start cloud query after ${startupDelay / 1000} Seconds...`);
        await this.delay(startupDelay);

        if (altitude_masl_in !== null && altitude_masl_in !== undefined) {
            let parsed = parseInt(altitude_masl_in, 10);

            if (isNaN(parsed)) {
                this.log.error('Meter above sea level has no valid value. Set it to 0');
                parsed = 0;
            }

            if (parsed < 0 || parsed > 8000) {
                this.log.error('Meter above sea level has no value between 0 and 8000. Set it to 0');
                parsed = 0;
            }

            altitude_masl = parsed;
        } else {
            this.log.error('Meter above sea level has no valid value. Set it to 0');
        }
        this.log.debug(`Meter above sea level ${altitude_masl}`);

        if (Number(sensor_in)) {
            sensor_id = parseInt(sensor_in);
            if (sensor_id < 1 || sensor_id > 20) {
                this.log.error('Sensor ID has no value between 1 and 20');
                this.terminate(2);
                return;
            }
        } else {
            this.log.error('Sensor ID has no valid value');
            this.terminate(2);
            return;
        }
        this.log.debug(`Sensor ID is ${sensor_id}`);

        if (username.trim().length === 0 || passwort.trim().length === 0) {
            this.log.error('User email and/or user password empty - please check instance configuration');
            this.stop(2);
            return;
        }

        let client = null;
        if (mqtt_active) {
            if (broker_address.trim().length === 0 || broker_address == '0.0.0.0') {
                this.log.error('MQTT IP address is empty - please check instance configuration');
                this.terminate(2);
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
                this.terminate(0);
                return;
            }
        } catch (err) {
            this.log.error(`Could not check or adjust the schedule: ${err.message}`);
        }

        this.log.debug(`MQTT active: ${mqtt_active}`);
        this.log.debug(`MQTT port: ${mqtt_port}`);

        const deviceId = `${this.namespace}.${sensor_id}`;

        const allStatesOkId = `${deviceId}.AllStatesOk`;
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
                rain_unit_mm,
                altitude_masl,
                `${deviceId}.forecast`,
                inversePowerStatus,
            );

            const dataReceived = mainResult.dataReceived;
            const devdata = mainResult.devdata;
            const status = mainResult.allStatesOk;

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
                const rainUnit = rain_unit_mm ? 'mm' : 'inch';
                const windUnit = wind_unit_kmh ? 'km/h' : 'MPH';

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

                for (let [key, value] of Object.entries(content)) {
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
                    if (type_ === 7) {
                        prefix = '-Atmos';
                    }

                    const key = `Channel${channel}-Type${type_}${prefix}`;
                    const base = `${devDataChannelId}.${key}`;

                    // current
                    if (cur_val !== null && cur_val !== undefined && cur_val !== 65535 && cur_val !== 255) {
                        const id = `${base}.current`;
                        const roleMap = {
                            '-Temp': 'value.temperature',
                            '-Hum': 'value.humidity',
                        };

                        const unitMap = {
                            '-Temp': tempUnit,
                            '-Hum': '%',
                            '-Atmos': 'hPa',
                        };

                        await this.setObjectNotExistsAsync(id, {
                            type: 'state',
                            common: {
                                name: 'current',
                                type: 'number',
                                role: roleMap[prefix] || 'value',
                                unit: unitMap[prefix] || '',
                                read: true,
                                write: false,
                            },
                            native: {},
                        });

                        let sendVal = cur_val;

                        if (type_ === 7) {
                            sendVal = pressureToSeaLevel(cur_val, altitude_masl);
                        }

                        await this.setStateAsync(id, { val: this.c_f_berechnen(sendVal, prefix, celsius), ack: true });
                    }
                    // high
                    if (high_val !== null && high_val !== undefined && high_val !== 65535 && high_val !== 255) {
                        const id = `${base}.high`;
                        const roleMap = {
                            '-Temp': 'value.temperature',
                            '-Hum': 'value.humidity',
                        };

                        const unitMap = {
                            '-Temp': tempUnit,
                            '-Hum': '%',
                            '-Atmos': 'hPa',
                        };

                        await this.setObjectNotExistsAsync(id, {
                            type: 'state',
                            common: {
                                name: 'current',
                                type: 'number',
                                role: roleMap[prefix] || 'value',
                                unit: unitMap[prefix] || '',
                                read: true,
                                write: false,
                            },
                            native: {},
                        });

                        let sendVal = high_val;

                        if (type_ === 7) {
                            sendVal = pressureToSeaLevel(high_val, altitude_masl);
                        }

                        await this.setStateAsync(id, { val: this.c_f_berechnen(sendVal, prefix, celsius), ack: true });
                    }
                    // low
                    if (low_val !== null && low_val !== undefined && low_val !== 65535 && low_val !== 255) {
                        const id = `${base}.low`;
                        const roleMap = {
                            '-Temp': 'value.temperature',
                            '-Hum': 'value.humidity',
                        };

                        const unitMap = {
                            '-Temp': tempUnit,
                            '-Hum': '%',
                            '-Atmos': 'hPa',
                        };

                        await this.setObjectNotExistsAsync(id, {
                            type: 'state',
                            common: {
                                name: 'current',
                                type: 'number',
                                role: roleMap[prefix] || 'value',
                                unit: unitMap[prefix] || '',
                                read: true,
                                write: false,
                            },
                            native: {},
                        });

                        let sendVal = low_val;

                        if (type_ === 7) {
                            sendVal = pressureToSeaLevel(low_val, altitude_masl);
                        }

                        await this.setStateAsync(id, { val: this.c_f_berechnen(sendVal, prefix, celsius), ack: true });
                    }

                    // dev*-Keys im Sensorobjekt
                    for (const [k, v] of Object.entries(s)) {
                        if (!k.startsWith('dev')) {
                            continue;
                        }
                        if (isInvalidValue(v, type_)) {
                            continue;
                        }

                        const baseId = `${base}.${k}`;

                        if (typeof v === 'object' && Object.keys(v).length === 0) {
                            // LEERES dev*-Objekt → alle existierenden Subkeys auf 0 setzen
                            const existingStates = await this.getStatesAsync(`${baseId}.*`);

                            // Existierende Subkeys holen und auf 0 setzen
                            for (const fullId of Object.keys(existingStates)) {
                                this.log.debug(`DP ${fullId} exists but JSON is empty. Set it to 0`);
                                await this.setStateAsync(fullId, { val: 0, ack: true });
                            }
                            continue;
                        }

                        // Einheit anhand des dev*-Keys bestimmen
                        let unit = '';
                        let isRain = false;

                        const keyLower = k.toLowerCase();

                        // Regen
                        if (keyLower.startsWith('devrain')) {
                            unit = rainUnit;
                            isRain = true;
                        }

                        // Wind
                        if (keyLower.startsWith('devwind')) {
                            unit = windUnit;
                        }

                        // Light → kLux (aber UV NICHT)
                        if (keyLower.includes('light') && !keyLower.includes('ultraviolet')) {
                            unit = 'kLux';
                        }

                        // UV → UVI
                        if (keyLower.includes('ultraviolet')) {
                            unit = 'UVI';
                        }

                        // Wenn v ein Objekt ist → Unterwerte einzeln anlegen
                        if (typeof v === 'object' && Object.keys(v).length > 0) {
                            for (const [subKey, subVal] of Object.entries(v)) {
                                if (isInvalidValue(subVal, type_)) {
                                    continue;
                                }
                                const id = `${baseId}.${subKey}`;

                                let val = subVal;
                                const subLower = subKey.toLowerCase();

                                // --- Light → /1000, aber UV NICHT ---
                                if (
                                    subLower.includes('light') &&
                                    !subLower.includes('ultraviolet') &&
                                    typeof val === 'number'
                                ) {
                                    val = val / 1000;
                                }

                                // --- Atmos ---
                                if ((type_ === 7 || k.toLowerCase().includes('atmos')) && typeof val === 'number') {
                                    val = pressureToSeaLevel(val, altitude_masl);
                                }

                                // --- Rain ---
                                if (isRain && typeof val === 'number') {
                                    val = this.mm_inch_berechnen(val, rain_unit_mm);
                                }

                                let finalUnit = unit;

                                // Light → kLux
                                if (subLower.includes('light') && !subLower.includes('ultraviolet')) {
                                    finalUnit = 'kLux';
                                }

                                // UV → UVI
                                if (subLower.includes('ultraviolet')) {
                                    finalUnit = 'UVI';
                                }

                                // Wind direction → °
                                if (subLower.includes('direction')) {
                                    finalUnit = '°';
                                }

                                await this.setObjectNotExistsAsync(id, {
                                    type: 'state',
                                    common: {
                                        name: `${k} ${subKey}`,
                                        type: typeof val,
                                        role: 'value',
                                        unit: finalUnit,
                                        read: true,
                                        write: false,
                                    },
                                    native: {},
                                });

                                await this.setStateAsync(id, { val: val, ack: true });
                            }

                            // Fehlende Subkeys auf 0 setzen
                            const existingStates = await this.getStatesAsync(`${baseId}.*`);

                            // Existierende Subkeys holen
                            for (const fullId of Object.keys(existingStates)) {
                                const existingSubKey = fullId.split('.').pop();

                                // Wenn dieser Subkey NICHT in der JSON vorkommt
                                if (!Object.keys(v).includes(existingSubKey)) {
                                    this.log.debug(`DP ${fullId} exists but is not in JSON. Set it to 0`);
                                    await this.setStateAsync(fullId, { val: 0, ack: true });
                                }
                            }
                        } else {
                            // Normaler dev*-Wert (kein Objekt)
                            const id = `${baseId}`;

                            if (isInvalidValue(v, type_)) {
                                continue;
                            }

                            let finalUnit = unit;
                            const endKey = k.toLowerCase();

                            // Light → kLux
                            if (endKey.includes('light') && !endKey.includes('ultraviolet')) {
                                finalUnit = 'kLux';
                            }

                            // UV → UVI
                            if (endKey.includes('ultraviolet')) {
                                finalUnit = 'UVI';
                            }

                            await this.setObjectNotExistsAsync(id, {
                                type: 'state',
                                common: {
                                    name: k,
                                    type: typeof v,
                                    role: 'value',
                                    unit: finalUnit,
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            });

                            let val2 = v;

                            // Atmos
                            if ((type_ === 7 || endKey.includes('atmos')) && typeof val2 === 'number') {
                                val2 = pressureToSeaLevel(val2, altitude_masl);
                            }

                            // Rain
                            if (endKey.startsWith('devrain') && typeof val2 === 'number') {
                                val2 = this.mm_inch_berechnen(val2, rain_unit_mm);
                            }

                            // Light → /1000, aber UV NICHT
                            if (
                                endKey.includes('light') &&
                                !endKey.includes('ultraviolet') &&
                                typeof val2 === 'number'
                            ) {
                                val2 = Math.round((val2 / 1000) * 100) / 100;
                            }

                            await this.setStateAsync(id, { val: val2, ack: true });
                        }
                    }
                }
                if (status !== undefined) {
                    await this.setStateAsync(allStatesOkId, { val: status, ack: true });
                }
                this.log.debug(`allStatesOk: ${status}`);
            } else {
                this.log.warn('No data received');
                await this.setStateAsync(systemStateId, { val: false, ack: true });
                //await this.setStateAsync(allStatesOkId, { val: false, ack: true });
            }
        } catch (error) {
            this.log.error(`Unexpected error in onReady(): ${error.message}`);
            this.terminate(1);
        } finally {
            if (client) {
                client.end();
            }
            this.log.info('Everything done. Going to terminate till next schedule');
            this.terminate(0);
        }
    }

    // Alle Statuswerte ok?
    async isSuccess(data, inversePowerStatus) {
        try {
            if (data.status !== 0) {
                this.log.warn(`status: ${data.status} (0 = OK)`);
                return false;
            }

            if (data.error !== 0) {
                this.log.warn(`error: ${data.error} (0 = OK)`);
                return false;
            }

            if (data.message !== 'success') {
                this.log.warn(`message: ${data.message} (success = OK)`);
                return false;
            }

            if (data.content?.powerStatus === 0 && !inversePowerStatus) {
                // inversePowerStatus = false and powerStatus = 0 → Power supply not OK
                this.log.warn(`content/powerStatus: ${data.content.powerStatus} → Power supply OK?`);
                return false;
            }

            // inversePowerStatus = true and powerStatus > 0 → Power supply OK
            //this.log.warn(`content/powerStatus: ${data.content.powerStatus} → Power supply OK?`);
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

    // inch nach mm umwandeln, falls notwendig
    mm_inch_berechnen(wert, rain_in_mm) {
        if (rain_in_mm) {
            wert = (wert * 25.4).toFixed(1);
        }
        return parseFloat(wert);
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
            this.log.warn(`Error during login: ${error.message || 'Reason unknown'}`);
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

    async main(
        client,
        username,
        passwort,
        mqtt_active,
        sensor_id,
        storeJson,
        storeDir,
        celsius,
        rain_unit_mm,
        altitude_masl,
        forecastChannelId,
        inversePowerStatus,
    ) {
        const token = await this.login(username, passwort);
        if (!token) {
            this.log.warn('No token received');
            if (mqtt_active) {
                await this.sendMqtt(sensor_id, mqtt_active, client, 'dataReceived', 'false');
                //await this.sendMqtt(sensor_id, mqtt_active, client, 'allStatesOk', 'false');
                client.end();
            }
            return {
                //allStatesOk: false,
                dataReceived: false,
            };
        }
        const devdata = await this.devData(token);
        const forecast = await this.foreCast(token);
        if (devdata === 'error' || forecast === 'error') {
            this.log.warn('No data received');
            if (mqtt_active) {
                await this.sendMqtt(sensor_id, mqtt_active, client, 'dataReceived', 'false');
                //await this.sendMqtt(sensor_id, mqtt_active, client, 'allStatesOk', 'false');
                client.end();
            }
            return {
                //allStatesOk: false,
                dataReceived: false,
            };
        }

        if (storeJson) {
            this.log.debug(`Save devData.json to ${storeDir}`);
            const json_object = JSON.stringify(devdata, null, 4);
            fs.writeFileSync(path.join(storeDir, `weathersense.${sensor_id}.devData.json`), json_object, 'utf-8');
        }

        this.printAllKeys(devdata);

        let status = await this.isSuccess(devdata, inversePowerStatus);

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

            // Atmos korrigieren
            if (content.atmos !== null && content.atmos !== undefined) {
                content.atmos = pressureToSeaLevel(content.atmos, altitude_masl);
            }

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

                // --- Prefix bestimmen ---
                let prefix = '';
                if (type_ === 1) {
                    prefix = '-Temp';
                }
                if (type_ === 2) {
                    prefix = '-Hum';
                }
                if (type_ === 7) {
                    prefix = '-Atmos';
                }

                const key = `Channel${channel}-Type${type_}${prefix}`;
                const base = `devData/${key}`;

                // --- Helper: nur 65535 filtern ---
                const sendIfValid = (topic, value) => {
                    if (!isInvalidValue(value, type_)) {
                        this.sendMqtt(
                            sensor_id,
                            mqtt_active,
                            client,
                            topic,
                            this.c_f_berechnen(value, prefix, celsius),
                        );
                    }
                };

                // --- Einzelwerte senden ---
                let curSend = cur_val;
                let highSend = high_val;
                let lowSend = low_val;

                if (type_ === 7) {
                    if (!isInvalidValue(cur_val, type_)) {
                        curSend = pressureToSeaLevel(cur_val, altitude_masl);
                    }
                    if (!isInvalidValue(high_val, type_)) {
                        highSend = pressureToSeaLevel(high_val, altitude_masl);
                    }
                    if (!isInvalidValue(low_val, type_)) {
                        lowSend = pressureToSeaLevel(low_val, altitude_masl);
                    }
                }

                sendIfValid(`${base}/current`, curSend);
                sendIfValid(`${base}/high`, highSend);
                sendIfValid(`${base}/low`, lowSend);

                // --- dev*-Werte senden ---
                for (const [k, v] of Object.entries(s)) {
                    if (!k.startsWith('dev')) {
                        continue;
                    }

                    // 65535 immer filtern, 255 nur bei Type 1 & 2
                    if (isInvalidValue(v, type_)) {
                        continue;
                    }

                    // leere Objekte filtern
                    if (typeof v === 'object' && Object.keys(v).length === 0) {
                        continue;
                    }

                    const devBase = `${base}/${k}`;

                    // Objekt → Unterwerte senden
                    if (typeof v === 'object' && Object.keys(v).length > 0) {
                        for (const [subKey, subVal] of Object.entries(v)) {
                            if (isInvalidValue(subVal, type_)) {
                                continue;
                            }

                            let val = subVal;
                            const endKey = subKey.toLowerCase();

                            // --- Atmos ---
                            if ((type_ === 7 || k.toLowerCase().includes('atmos')) && typeof val === 'number') {
                                val = pressureToSeaLevel(val, altitude_masl);
                            }

                            // --- Rain ---
                            if (k.startsWith('devRain') && typeof val === 'number') {
                                val = this.mm_inch_berechnen(val, rain_unit_mm);
                            }

                            // --- Light → /1000, aber UV NICHT ---
                            if (
                                endKey.includes('light') &&
                                !endKey.includes('ultraviolet') &&
                                typeof val === 'number'
                            ) {
                                val = Math.round((val / 1000) * 100) / 100;
                            }

                            this.sendMqtt(sensor_id, mqtt_active, client, `${devBase}/${subKey}`, val);
                        }
                    } else {
                        // Einzelwert
                        if (isInvalidValue(v, type_)) {
                            continue;
                        }

                        let val = v;
                        const endKey = k.toLowerCase();

                        // --- Atmos ---
                        if ((type_ === 7 || endKey.includes('atmos')) && typeof val === 'number') {
                            val = pressureToSeaLevel(val, altitude_masl);
                        }

                        // --- Rain ---
                        if (k.startsWith('devRain') && typeof val === 'number') {
                            val = this.mm_inch_berechnen(val, rain_unit_mm);
                        }

                        // --- Light → /1000, aber UV NICHT ---
                        if (endKey.includes('light') && !endKey.includes('ultraviolet') && typeof val === 'number') {
                            val = Math.round((val / 1000) * 100) / 100;
                        }

                        this.sendMqtt(sensor_id, mqtt_active, client, devBase, val);
                    }
                }
            }
        }

        if (storeJson) {
            this.log.debug(`Save forecast.json to ${storeDir}`);
            const json_object = JSON.stringify(forecast, null, 4);
            fs.writeFileSync(path.join(storeDir, `weathersense.${sensor_id}.forecast.json`), json_object, 'utf-8');
        }

        this.printAllKeys(forecast);

        if (status) {
            status = await this.isSuccess(forecast, inversePowerStatus);
        }

        const forecasts = forecast?.content?.forecast?.forecasts || [];

        if (mqtt_active) {
            await this.clearOldForecasts(sensor_id, client, 6);

            await this.delay(1000);

            await this.sendForecasts(client, forecasts, celsius, sensor_id);
            if (status !== undefined) {
                await this.sendMqtt(sensor_id, mqtt_active, client, 'allStatesOk', status);
            }

            client.end();
        }

        await this.createOrUpdateForecastDPs(forecastChannelId, forecasts, celsius);

        return {
            allStatesOk: status,
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
