![Logo](admin/weathersense.png)

# ioBroker.weathersense

## WeatherSense Adapter für ioBroker

WeatherSense ist eine Cloud für Wetterstationen. Dieser Adapter liest die Daten vom WeatherSense Server.

Siehe: https://play.google.com/store/apps/details?id=com.emax.weahter&hl=de_CH

Manche Wifi Wetterstationen nutzen die WeatherSense Cloud.

Beispielsweise diese Wifi Wetterstation von Ideoon (Pearl):

![Screenshot](https://github.com/ltspicer/WeatherSense/blob/main/wetterstation.png)

## Benutzung:

Lediglich Login Daten vom WeatherSense Account eintragen (Email und Passwort).
Die Wetterstationsdaten werden im Datenpunkt weathersense gespeichert.
Die Daten können auch per MQTT versendet werden.

## 🚀 Nutzung mehrerer Wetterstationen (Mehrfach-Instanzen-Support)

Der originale WeatherSense-Cloud-Server hat eine softwareseitige Einschränkung bzw. einen Bug: Wenn du zwei oder mehr identische Wetterstationen im selben Smartphone-Account registrierst, überschreiben sie sich gegenseitig und verschwinden aus deiner Geräteliste.

Um die Daten von mehreren Stationen gleichzeitig und ohne Konflikte auszulesen, kannst du ganz einfach die native Mehrfach-Instanzen-Architektur von ioBroker nutzen.

### Schritt-für-Schritt-Einrichtung:

1. **Separate Cloud-Accounts erstellen:** Registriere in der WeatherSense-App für **jede** deiner Wetterstationen einen eigenen, kostenlosen Account (z. B. *Email A* für Station 1 und *Email B* für Station 2).
2. **Eine Station pro Account binden:** Kopple deine erste Station strikt mit Account A und deine zweite Station strikt mit Account B.
3. **Mehrere Instanzen in ioBroker hinzufügen:**
   * Gehe in ioBroker auf den Reiter `Instanzen` und füge eine zweite Instanz des WeatherSense-Adapters hinzu (dadurch entstehen `weathersense.0` und `weathersense.1`).
4. **Die Instanzen konfigurieren:**
   * Öffne die Einstellungen für **`weathersense.0`** und gib die Zugangsdaten für **Account A** ein. Setze die `Sensor-ID` auf `1`.
   * Öffne die Einstellungen für **`weathersense.1`** und gib die Zugangsdaten für **Account B** ein. Setze die `Sensor-ID` auf `2`.

### 💡 Vorteile dieser Einrichtung:
* **Keine Datenkonflikte:** ioBroker startet zwei völlig voneinander unabhängige Prozesse.
* **Getrennte Objekte:** Deine Datenpunkte werden sauber in `weathersense.0.*` und `weathersense.1.*` aufgeteilt.
* **Sauberes MQTT-Routing:** Wenn du die integrierte MQTT-Funktion nutzt, werden deine Topics durch die Sensor-ID sauber getrennt (z. B. `weathersense/1/...` und `weathersense/2/...`). Das verhindert, dass sich die Daten auf deinem Broker gegenseitig überschreiben.

## License

MIT License

Copyright (c) 2026 Daniel Luginbühl <webmaster@ltspiceusers.ch>
