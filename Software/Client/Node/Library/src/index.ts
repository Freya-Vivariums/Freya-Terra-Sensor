/*
 * Freya Vivarium Control System - Freya Terra Sensor SDK
 * Copyright (C) 2025 Sanne 'SpuQ' Santens
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * @file index.ts
 * @module @freya-vivariums/freya-terra-sensor
 * @description
 * Node.js/TypeScript SDK for the io.freya.EnvironmentSensorDriver D-Bus service.
 * Provides the SensorDriver class for connecting to and receiving measurements
 * from the Freya Terra Sensor driver.
 *
 * @copyright 2025 Sanne "SpuQ" Santens
 * @license MIT
 */

const dbus = require('dbus-native');
import { EventEmitter } from 'events';

export class SensorDriver extends EventEmitter {
  private iface: any;                   // The interface of the Environment Sensor Driver
  private bus = dbus.systemBus();       // The DBus interface

  constructor() {
    super();
    this.init();
  }

  async init() {
    try {
      await this.initDriverConnection();
      console.log('Connected to sensor driver');
      this.emit('status', { level: "ok", message: "Connected to sensor driver" });
    }
    catch (err) {
      console.error('Error connecting to sensor driver:', err);
      this.emit('status', { level: "error", message: "No connection to driver" });
      setTimeout(() => { this.init() }, 5 * 1000);
    }

    /*
     *  Signal handlers
     */
    this.iface.on('measurement', (type: string, value: string) => {
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
      service.getInterface('/io/freya/EnvironmentSensorDriver', 'io.freya.EnvironmentSensorDriver', (err: Error | null, iface: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(iface);
        }
      });
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
      this.iface.setSampleInterval(
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
