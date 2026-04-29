/*
 *  Freya "Terra" Sensor Driver (for Linux/Debian)
 *  The hardware-dependent component of the Freya Vivarium Control System, designed
 *  for use with the Freya "Terra" Sensor (Rev 1.x).
 *
 *  Copyright© 2025-2026 Sanne “SpuQ” Santens
 * 
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const dbus = require('dbus-native');
import { EventEmitter } from 'events';

//import IC libraries
import BME680 from './bme680';
import VEML6030 from './veml6030';
import AS7331 from './as7331';

const BME680_I2C_ADDRESS = 0x76;
const VEML6030_I2C_ADDRESS = 0x10;
const AS7331_I2C_ADDRESS = 0x74;

// D-Bus configuration
const DBUS_SERVICE   = 'io.freya.EnvironmentSensorDriver';
const DBUS_PATH    =  '/io/freya/EnvironmentSensorDriver';
const DBUS_INTERFACE = 'io.freya.EnvironmentSensorDriver';
// Sensor sample interval limits
const SAMPLEINT_MIN = 0.5           // 30 seconds
const SAMPLEINT_MAX = 12*60*60*1000 // 12 hours

class EnvSensorDriver extends EventEmitter {
  public sampleInterval = 10*1000;   // Default interval set to 10 seconds

  constructor(private bus: any) {
    super();
    // export D-Bus interface as soon as we construct
    bus.exportInterface(
      this,     // for emiting signals (?)
      DBUS_PATH,
      {
        name: DBUS_INTERFACE,
        methods: {
          setSampleInterval: ['i', 'b']
        },
        signals: {
          measurement: ['ss','s']
        }
      }
    );
  }

  // D-Bus-exposed method:
  setSampleInterval(interval: number): boolean {
    // Reject interval settings that are out of bounds
    if( interval < SAMPLEINT_MIN || interval > SAMPLEINT_MAX ) return false;
    // Set the interval and return success
    this.sampleInterval = interval*1000;
    return true;
  }

  // whenever you want to send a new reading down the bus:
  public pushMeasurement(variable: string, value: string ) {
    // this.emit is EventEmitter.emit; dbus-native watches for it
    this.emit('measurement', variable, value);
  }
}

async function main() {
  // DBus client
  const systemBus = dbus.systemBus();
  // Initialize the BME680
  const bme680 = new BME680( BME680_I2C_ADDRESS );   // Create the BME680 driver object
  await bme680.init();                               // Initialize the BME680

  // Initialize the VEML6030
  const veml6030 = new VEML6030( VEML6030_I2C_ADDRESS );
  await veml6030.init();

  // Inintialize the AS7331
  const as7331 = new AS7331( AS7331_I2C_ADDRESS );
  await as7331.init();

  // 1) acquire the well-known name
  systemBus.requestName(DBUS_SERVICE, 0, (err: any, retCode: number) => {
    if (err) {
      console.error('Failed to request name:', err);
      process.exit(1);
    }
    if (retCode !== 1) {
      console.error('Name already taken or unexpected reply:', retCode);
      process.exit(1);
    }

    console.log(`Acquired ${DBUS_SERVICE} on system bus`);
    // 2) now we can create & export our driver
    const driver = new EnvSensorDriver(systemBus);

    // 3) periodically emit
    setInterval(async() => {
      let data:any = await bme680.read();
      driver.pushMeasurement('temperature', data.temperature.toFixed(1));
      driver.pushMeasurement('humidity', data.humidity.toFixed(1));
      driver.pushMeasurement('pressure', data.pressure.toFixed(1));
      //driver.pushMeasurement('gasresistance', data.gasResistance.toFixed(0));
      driver.pushMeasurement('airquality', data.airQuality.toFixed(0));

      data = await veml6030.read();
      driver.pushMeasurement('light', data.lux.toFixed(2));

      data = await as7331.read();
      driver.pushMeasurement('uva', data.uva.toFixed(1));
      driver.pushMeasurement('uvb', data.uvb.toFixed(1));
      driver.pushMeasurement('uvc', data.uvc.toFixed(1));
      
    }, driver.sampleInterval);
  });
}

main();