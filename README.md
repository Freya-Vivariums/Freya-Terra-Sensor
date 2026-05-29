![Freya banner](https://raw.githubusercontent.com/Freya-Vivariums/.github/refs/heads/main/brand/Freya_banner.png)

<img src="Documentation/Sensor_rendering.png" align="right" width="40%"/>

The **Freya Terra Sensor** is the control system's eyes and ears within the vivarium - the hardware that enables measurement of environmental conditions experienced by the inhabitants of the vivarium.

#### Measurement capabilities:
- Temperature
- Relative air humidity
- Barometric pressure
- Air quality (VOC)
- Ambient light (visible spectrum)
- UVA/UVB/UVC (spectral 220-400nm)

<br clear="right"/>

## Hardware
Designed with **[KiCad](https://www.kicad.org/download/)**, the Freya Terra Sensor's electronic hardware is a curated collection of high-end integrated circuit sensors for comprehensive environmental monitoring.

- Bosch **BME680** (**0x76**): Integrated environmental sensor combining **temperature**, **humidity**, **barometric pressure**, and VOC gas sensing for **air quality** monitoring. **[Datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme680-ds001.pdf)**
- Vishay **VEML6030** (**0x10**): High-accuracy **ambient light** sensor with spectral response matching the human eye for precise lux measurement and photoperiod management. **[Datasheet](https://www.vishay.com/docs/84366/veml6030.pdf)**
- ams OSRAM **AS7331** (**0x74**): Three-channel **spectral UV** sensor with separated UVA, UVB, and UVC detection for UV bulb monitoring and safety verification. **[Datasheet](https://look.ams-osram.com/m/1856fd2c69c35605/original/AS7331-Spectral-UVA-B-C-Sensor.pdf)**
- Microchip **MIC5225-3.3YM5**: The sensor module operates internally at 3.3V but accepts 5V input for improved noise immunity over longer cable runs. The on-board voltage regulator provides clean 3.3V power to all sensor ICs, while a bi-directional level shifter handles I²C communication between the 5V bus and 3.3V sensors.
- The **JST PH 2.0mm 4-Pin connector** allows for easy replacement of the board.

> [!NOTE]  
> The PCB is finished with a coating for resisting the humid conditions.

## Enclosure
<img src="Documentation/Enclosure_Exploded.png" align="right" width="40%"/>

The sensor's enclosure is designed in **[FreeCAD](https://www.freecad.org/downloads.php?lang=en)**. It protects the sensitive equipment from the challenges of the environment within the vivarium. The **quartz tube** provides full-spectrum light transparency for spectral measurements while **mesh-filtered ventilation** in the end caps enables air exchange for sensing. The internal holder positions the PCB and facilitates assembly.

<br clear="right"/>

## Software
The sensor driver is a TypeScript/Node.js application that runs as a systemd service on Linux/Debian systems. It provides sensor readings via D-Bus for integration with the Freya Vivarium Control System Node-RED application.

#### Installation
When installing the Freya system, the sensor driver is automatically installed. For manual installation:

```bash
wget -O install.sh https://github.com/Freya-Vivariums/Freya-terra-sensor/releases/latest/download/install.sh
chmod +x ./install.sh
sudo ./install.sh
```

The service runs automatically and can be monitored with:
```bash
systemctl status freya.sensor.terra.service
journalctl -u freya.sensor.terra.service -f
```

#### D-Bus Interface
Applications interact with the sensor via D-Bus on the system bus:
- **Service:** `freya.sensor.terra`
- **Path:** `/freya/sensor/terra`
- **Signals:** `measurement(variable: string, value: string)` - Emits readings for temperature, humidity, pressure, light, UVA, UVB, and UVC

## License & Collaboration
**Copyright© 2024-2026 Sanne 'SpuQ' Santens**. The hardware and enclosure are released under the [**CERN OHL-W**](Hardware/LICENSE.txt) license. The software is released under the [**GNU GPL-3.0**](Software/LICENSE.txt) license. [Trademark rules](https://github.com/Freya-Vivariums/.github/blob/main/brand/Freya_Trademark_Rules_and_Guidelines.md) apply to the Freya™ brand.

### Collaboration

If you'd like to contribute to this project, please follow these guidelines:
1. Fork the repository and create your branch from `main`.
2. Make your changes and ensure they adhere to the project's design style and conventions.
3. Test your changes thoroughly.
4. Ensure your commits are descriptive and well-documented.
5. Open a pull request, describing the changes you've made and the problem or feature they address.