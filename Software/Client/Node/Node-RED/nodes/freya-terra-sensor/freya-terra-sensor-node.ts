/*
 * Freya Vivarium Control System - Freya Terra Sensor Node
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
 * @file freya-terra-sensor-node.ts
 * @module freya-terra-sensor-node
 * @description
 * Node-RED node that uses the `freya-terra-sensor` library to communicate
 * with the Freya Environment Sensor Driver over D-Bus.
 *
 * @copyright 2025 Sanne "SpuQ" Santens
 * @license MIT
 */

import { NodeAPI, NodeInitializer, Node, NodeMessageInFlow, NodeDef } from 'node-red';
import { SensorDriver } from '@freya-vivariums/freya-terra-sensor';

interface NodeConfig extends NodeDef {
  name: string;
  variable: string;
  sampleinterval: string;
}

const freyaTerraSensor: NodeInitializer = (RED: NodeAPI) => {
  function FreyaTerraSensorNode( this: Node, config: NodeConfig ) {
    RED.nodes.createNode(this, config);
    const node = this;

    const variable = config.variable;
    const sampleinterval = parseFloat(config.sampleinterval as any) || 1.0;

    const sensorDriver = new SensorDriver();

    // On status events from the driver
    sensorDriver.on('status',(status:any)=>{
        switch (status.level){
            case 'ok':      node.status({ fill: 'green', shape: 'dot', text: status.message });
                            break;
            case 'warning': node.status({ fill: 'yellow', shape: 'dot', text: status.message });
                            break;
            default:        node.status({ fill: 'red', shape: 'dot', text: status.message });
                            break;
        }
    })

    /* Handler for 'measurement' data received from the driver */
    sensorDriver.on('measurement', (measurement:any)=>{
      // If this is a measurement the user has set with 'variable,
      // then emit it. Otherwise just skip.
      if( Object.prototype.hasOwnProperty.call(measurement, variable) || variable === 'all'){
        const msg:NodeMessageInFlow = {
          _msgid: '',
          topic: "measurement",
          payload: measurement
        }
        this.send(msg);
      }
    });
  }

  RED.nodes.registerType('freya-terra-sensor', FreyaTerraSensorNode);
};

export = freyaTerraSensor;
