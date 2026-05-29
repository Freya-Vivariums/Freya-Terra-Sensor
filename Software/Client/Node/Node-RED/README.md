![Freya Banner](https://raw.githubusercontent.com/Freya-Vivariums/.github/refs/heads/main/brand/Freya_banner.png)

<img src="https://nodered.org/about/resources/media/node-red-icon.png" align="right" width="10%"/>

**[Node-RED](https://nodered.org/)** is a visual programming tool that lets you wire together hardware, APIs, and online services by connecting blocks in a flow-based editor. The **Freya Terra Sensor** Node-RED node brings environmental sensor data from the Freya Terra Sensor directly into your Node-RED flows over D-Bus.

<br clear="right"/>

[![npm](https://img.shields.io/npm/v/@freya-vivariums/freya-terra-sensor-node-red-contrib)](https://www.npmjs.com/package/@freya-vivariums/freya-terra-sensor-node-red-contrib)

## Installation
#### Node-RED flow editor
Navigate to `Settings > Manage Palette`, then in the `Install` tab, search for `@freya-vivariums/freya-terra-sensor-node-red-contrib` and click the `Install` button.

#### Manually using NPM
On your device, navigate to the Node-RED folder (on a Freya system, it's at `/opt/Freya/nodered`), and run:
```
npm install @freya-vivariums/freya-terra-sensor-node-red-contrib
```

## Node: Freya Terra Sensor
Connects to the `io.freya.EnvironmentSensorDriver` D-Bus service and emits measurement messages into your flow. Configure which environment variable to receive (`temperature`, `humidity`, `pressure`, `light`, etc.) or select **All measurements** to receive every reading.

## License & Collaboration
**Copyright© 2025 Sanne 'SpuQ' Santens**. This project is licensed under the **[MIT License](LICENSE.txt)**. The [Rules & Guidelines](https://github.com/Freya-Vivariums/.github/blob/main/brand/Freya_Trademark_Rules_and_Guidelines.md) apply to the usage of the Freya Vivariums™ brand.

### Collaboration
If you'd like to contribute to this project, please follow these guidelines:
1. Fork the repository and create your branch from `main`.
2. Make your changes and ensure they adhere to the project's coding style and conventions.
3. Test your changes thoroughly.
4. Ensure your commits are descriptive and well-documented.
5. Open a pull request, describing the changes you've made and the problem or feature they address.
