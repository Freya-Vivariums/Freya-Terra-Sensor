/*
 * Freya Vivarium Control System - Freya Terra Sensor Node
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
 * @file freya-terra-sensor-node.ts
 * @module freya-terra-sensor-node
 * @description
 * Node-RED node that uses the `freya-terra-sensor` library to communicate
 * with the Freya Environment Sensor Driver over D-Bus.
 *
 * @copyright 2025 Sanne "SpuQ" Santens
 * @license GPL-3.0
 */

import { NodeAPI, NodeInitializer, Node, NodeMessageInFlow, NodeDef } from 'node-red';
import { SensorDriver } from './freya-terra-sensor';

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
