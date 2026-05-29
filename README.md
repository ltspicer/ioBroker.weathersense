![Logo](admin/weathersense.png)

# ioBroker.weathersense

[![NPM version](https://img.shields.io/npm/v/iobroker.weathersense.svg)](https://www.npmjs.com/package/iobroker.weathersense)
[![Downloads](https://img.shields.io/npm/dm/iobroker.weathersense.svg)](https://www.npmjs.com/package/iobroker.weathersense)
![Number of Installations](https://iobroker.live/badges/weathersense-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/weathersense-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.weathersense.png?downloads=true)](https://nodei.co/npm/iobroker.weathersense/)

**Tests:** ![Test and Release](https://github.com/ltspicer/ioBroker.weathersense/workflows/Test%20and%20Release/badge.svg)

## WeatherSense adapter for ioBroker

WeatherSense is a cloud for weather stations. This adapter reads data from the WeatherSense server.

See: https://play.google.com/store/apps/details?id=com.emax.weahter&hl=de_CH

Some WiFi weather stations use the WeatherSense Cloud.

For example, this WiFi weather stations from Ideoon (Pearl):

![Screenshot](https://github.com/ltspicer/WeatherSense/blob/main/wetterstation.png)

![Screenshot](https://github.com/ltspicer/WeatherSense/blob/main/casativo_ideoon_weatherstation.png)

## Use:

Simply enter your WeatherSense account login details (email and password).
The weather station data is stored in the weathersense data point.
The data can also be sent via MQTT.

## Changelog
### 4.4.2 (2026-05-29)

- Translation issues resolved

### 4.4.1 (2026-05-26)

- process.exit() issue resolved

### 4.4.0 (2026-04-06)

- node > 20

### 4.3.0 (2026-03-05)

- "Ignore PowerStatus warning" option added

### 4.2.2 (2026-03-04)

- powerStatus:0 message changed from warn to info
