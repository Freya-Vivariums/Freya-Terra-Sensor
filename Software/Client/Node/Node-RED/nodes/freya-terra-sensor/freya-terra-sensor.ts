/*
 * Freya Vivarium Control System - Freya Terra Sensor Library
 * Copyright (C) 2025 Sanne 'SpuQ' Santens
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * @file freya-terra-sensor.ts
 * @module freya-terra-sensor
 * @description
 * Node.js/TypeScript client for the io.freya.EnvironmentSensorDriver D-Bus service
 *
 * @copyright 2025 Sanne "SpuQ" Santens
 * @license GPL-3.0
 */

const dbus =  require('dbus-native');
import { EventEmitter } from 'events';

export class SensorDriver extends EventEmitter{
  private iface: any;                   // The interface of the Environment Sensor Driver
  private bus = dbus.systemBus();       // The DBus interface

  constructor(){
    super();
    this.init();
  }

  async init(){
        try{
            await this.initDriverConnection();
            console.log('Connected to sensor driver');
            this.emit('status', {level:"ok", message:"Connected to sensor driver"});
        }
        catch(err){
            console.error('Error connecting to sensor driver:', err);
            this.emit('status', {level:"error", message:"No connection to driver"});
            setTimeout(()=>{this.init()}, 5*1000);
        }

        /*
         *  Signal handlers
         */
        this.iface.on('measurement', (type:string, value:string) => {
            const parsedValue = isNaN(Number(value)) ? value : Number(value);
            this.emit('measurement', { [type]: parsedValue });
        });
  }

  /**
   * Initialize D-Bus connection and proxy interface
   */
  async initDriverConnection(): Promise<void> {
    const service = this.bus.getService('io.freya.EnvironmentSensorDriver');
    this.iface = await new Promise((resolve, reject) => {
      service.getInterface( '/io/freya/EnvironmentSensorDriver', 'io.freya.EnvironmentSensorDriver', (err: Error | null, iface: any) => {
          if (err) {
            reject(err);
          } else {
            resolve(iface);
          }
        }
      );
    });
  }

  /**
   * Set the Sample Interval.
   * @param interval - integer interval in seconds
   * @returns boolean indicating success
   */
  async setSampleInterval(interval: number): Promise<boolean> {
    if (!this.iface) {
      throw new Error('Driver not initialized. Call init() first.');
    }
    return new Promise((resolve, reject) => {
      this.iface.setDigitalOutput(
        interval,
        (err: Error | null, result: boolean) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        }
      );
    });
  }
}
