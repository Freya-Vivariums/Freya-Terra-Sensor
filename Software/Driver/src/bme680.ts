import { openPromisified } from 'i2c-bus';
/**
 * BME680 sensor driver
 * Provides temperature, pressure, humidity, and gas resistance readings.
 */
class BME680 {
    private i2c: any;
    private address: number;
    // Calibration parameters (parsed from sensor)
    private par_T1!: number;
    private par_T2!: number;
    private par_T3!: number;
    private par_P1!: number;
    private par_P2!: number;
    private par_P3!: number;
    private par_P4!: number;
    private par_P5!: number;
    private par_P6!: number;
    private par_P7!: number;
    private par_P8!: number;
    private par_P9!: number;
    private par_P10!: number;
    private par_H1!: number;
    private par_H2!: number;
    private par_H3!: number;
    private par_H4!: number;
    private par_H5!: number;
    private par_H6!: number;
    private par_H7!: number;
    private par_GH1!: number;
    private par_GH2!: number;
    private par_GH3!: number;
    // Other compensation parameters
    private res_heat_range!: number;
    private res_heat_val!: number;
    private range_sw_err!: number;
    private t_fine!: number;  // temperature fine value for compensation

    /**
     * Initialize the BME680 sensor.
     * @param busNumber I2C bus number (default 1 on Raspberry Pi).
     * @param address I2C address (0x76 default, or 0x77).
     */
    constructor(busNumber: number = 1, address: number = 0x76) {
        this.address = address;
        // Note: actual initialization is async (performed in init() method).
    }

    /**
    * Initialize sensor: reset, verify ID, read calibration and configure.
    * @throws Error if chip ID mismatches (expected 0x61).
    */
    async init(): Promise<void> {
        this.i2c = await openPromisified(1);
        // Soft-reset the sensor
        await this.i2c.writeByte(this.address, 0xE0, 0xB6);
        await new Promise(res => setTimeout(res, 10));  // 10ms delay for reset

        // Check device ID (should be 0x61 for BME680)
        const chipId = await this.i2c.readByte(this.address, 0xD0);
        if (chipId !== 0x61) {
            throw new Error(`BME680 not found at 0x${this.address.toString(16)} (chip ID mismatch)`);
        }

        // Read calibration data (41 bytes in two blocks)
        const calib1 = Buffer.alloc(25);
        const calib2 = Buffer.alloc(16);
        await this.i2c.readI2cBlock(this.address, 0x89, 25, calib1);
        await this.i2c.readI2cBlock(this.address, 0xE1, 16, calib2);
        const calib = Buffer.concat([calib1, calib2]);

        // Parse temperature calibration (little-endian)
        this.par_T1 = calib.readUInt16LE(33);
        this.par_T2 = calib.readInt16LE(1);
        this.par_T3 = calib.readInt8(3);
        // Parse pressure calibration
        this.par_P1 = calib.readUInt16LE(5);
        this.par_P2 = calib.readInt16LE(7);
        this.par_P3 = calib.readInt8(9);
        this.par_P4 = calib.readInt16LE(11);
        this.par_P5 = calib.readInt16LE(13);
        this.par_P6 = calib.readInt8(16);
        this.par_P7 = calib.readInt8(15);
        this.par_P8 = calib.readInt16LE(19);
        this.par_P9 = calib.readInt16LE(21);
        this.par_P10 = calib.readUInt8(23);
        // Parse humidity calibration (note H1 and H2 are split across bytes)
        const H1_LSB = calib[26] & 0x0F;
        const H1_MSB = calib[27] & 0xFF;
        const H2_LSB = calib[26] >> 4;
        const H2_MSB = calib[25] & 0xFF;
        this.par_H1 = (H1_MSB << 4) | H1_LSB;
        this.par_H2 = (H2_MSB << 4) | H2_LSB;
        this.par_H3 = calib.readInt8(28);
        this.par_H4 = calib.readInt8(29);
        this.par_H5 = calib.readInt8(30);
        this.par_H6 = calib.readUInt8(31);
        this.par_H7 = calib.readInt8(32);
        // Parse gas calibration
        this.par_GH1 = calib.readInt8(37);
        this.par_GH2 = calib.readInt16LE(35);
        this.par_GH3 = calib.readInt8(38);

        // Read additional compensation parameters from separate registers
        const reg02 = await this.i2c.readByte(this.address, 0x02);
        this.res_heat_range = (reg02 & 0x30) >> 4;             // bits 4-5 of 0x02
        this.res_heat_val = await this.i2c.readByte(this.address, 0x00);  // signed value
        let reg04 = await this.i2c.readByte(this.address, 0x04);
        this.range_sw_err = (reg04 & 0xF0) >> 4;
        if (this.range_sw_err > 7) { 
            // convert 4-bit value to signed 8-bit
            this.range_sw_err = this.range_sw_err - 16;
        }

        // Set oversampling and filter (recommendation: T=x8, P=x4, H=x2, Filter=3)
        await this.i2c.writeByte(this.address, 0x72, 0x02);  // ctrl_hum: Humidity oversampling = 2x (0x02)
        await this.i2c.writeByte(this.address, 0x75, 0x08);  // config: IIR filter coefficient = 3 (0x02 << 2 = 0x08)
        // Prepare ctrl_meas with oversampling settings (leave mode bits 00 for now)
        const osrs_t = 0x04;  // Temperature oversample = 8x
        const osrs_p = 0x03;  // Pressure oversample = 4x
        const mode = 0x00;    // sleep mode (we'll set forced mode when reading)
        await this.i2c.writeByte(this.address, 0x74, (osrs_t << 5) | (osrs_p << 2) | mode);
    }

    /**
    * Perform a forced-mode measurement and return compensated results.
    * @returns Object with temperature (°C), pressure (hPa), humidity (%RH), gasResistance (Ω), airQuality (0-5).
    */
    async read(): Promise<{
        temperature: number,      // in °C
        pressure: number,         // in hPa
        humidity: number,         // in %RH
        gasResistance: number,    // in Ohms
        airQuality: number        // 0 (bad) to 5 (excellent) - requires 5min heater warm-up, affected by high humidity >80% RH
    }> {
        // Ensure gas sensor is enabled for this measurement (set run_gas = 1 for profile 0)
        await this.i2c.writeByte(this.address, 0x71, 0x10);  // ctrl_gas (0x71): 0x10 sets bit4 (run_gas), profile 0

        // Set sensor to forced mode to start measurement
        let ctrl_meas = await this.i2c.readByte(this.address, 0x74);
        ctrl_meas = (ctrl_meas & 0xFC) | 0x01;  // set mode bits to 01 (forced mode)
        await this.i2c.writeByte(this.address, 0x74, ctrl_meas);

        // Wait for measurement to complete by polling status (new_data bit)
        const data = Buffer.alloc(15);
        do {
            await new Promise(res => setTimeout(res, 5));
            await this.i2c.readI2cBlock(this.address, 0x1D, 15, data);
        } while ((data[0] & 0x80) === 0);  // bit7 of 0x1D is new_data flag

        // Extract raw ADC values from the data buffer
        const adc_temp = ((data[5] << 12) | (data[6] << 4) | (data[7] >> 4)) >>> 0;
        const adc_pres = ((data[2] << 12) | (data[3] << 4) | (data[4] >> 4)) >>> 0;
        //const adc_pres = ((data[2] << 16) | (data[3] << 8) | data[4]) >>> 0;
        //const adc_temp = ((data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
        const adc_hum  = ((data[8] << 8) | data[9]) >>> 0;
        // Gas resistance raw: 10 bits from data[13..14], and gas range in low 4 bits of data[14]

        const adc_gas_res = (((data[13] << 8) | data[14]) >> 6) >>> 0;
        const gas_range = data[14] & 0x0F;
        /*
        console.log("[DEBUG] Raw ADC values:");
        console.log("adc_pres : ", adc_pres);
        console.log("adc_temp : ", adc_temp);
        console.log("adc_hum : ", adc_hum);
        console.log("adc_gas_res : ", adc_gas_res);
        */
        // Compute compensated values:
        const temperature = this.compensateTemperature(adc_temp);         // °C
        const pressure = this.compensatePressure(adc_pres) / 100;         // Pa -> hPa
        const humidity = this.compensateHumidity(adc_hum);                // %RH
        const gasResistance = this.compensateGas(adc_gas_res, gas_range); // Ω
        const airQuality = this.classifyAirQuality(gasResistance);

        return { temperature, pressure, humidity, gasResistance, airQuality };
    }

  /**
   * Temperature compensation (BME680 datasheet - 3.9).
   * @param adc_T - Raw 20-bit ADC value.
   * @returns Temperature in °C.
   */
    private compensateTemperature(adc_T: number): number {
        // Formulas use fixed-point arithmetic as per datasheet
        const var1 = (adc_T >> 3) - (this.par_T1 << 1);
        const var2 = (var1 * this.par_T2) >> 11;
        let var3 = (var1 >> 1) * (var1 >> 1);
        var3 = (var3 >> 12) * (this.par_T3 << 4);
        var3 = var3 >> 14;
        this.t_fine = var2 + var3;
        const T = ((this.t_fine * 5) + 128) >> 8;  // t_fine * 5 / 256
        return T / 100;  // convert to °C
    }

    /**
    * Pressure compensation (§3.10).
    * @param adc_P - Raw 20-bit ADC value.
    * @returns Pressure in Pa.
    */
    private compensatePressure(adc_P: number): number {
        // Uses t_fine from temperature compensation
        let var1 = (this.t_fine / 2) - 64000;
        let var2 = var1 * var1 * (this.par_P6 as number) / 131072;
        var2 += var1 * this.par_P5 * 2;
        var2 = (var2 / 4) + (this.par_P4 * 65536);
        var1 = ((this.par_P3 * var1 * var1 / 524288) + (this.par_P2 * var1)) / 524288;
        var1 = (1 + var1 / 32768) * this.par_P1;
        if (var1 === 0) {
            return 0;  // avoid division by zero
        }
        let p = 1048576 - adc_P;
        p = ((p - (var2 / 4096)) * 6250) / var1;
        var1 = this.par_P9 * p * p / 2147483648;
        var2 = p * this.par_P8 / 32768;
        let var3 = p * p * p * this.par_P10 / 281474976710656;
        p = p + (var1 + var2 + var3 + this.par_P7 * 128) / 16;
        return p;  // Pa
    }

    /**
    * Humidity compensation (BME680 datasheet - 3.11).
    * @param adc_H - Raw 16-bit ADC value.
    * @returns Relative humidity in %RH.
    */
    private compensateHumidity(adc_H: number): number {
        // Uses t_fine (fine temp) as well
        const temp_scaled = (this.t_fine * 5 + 128) >> 8;  // t_fine / 5120 -> °C*100
        let var1 = adc_H - (this.par_H1 * 16) - ((temp_scaled * this.par_H3) / 200);
        let var2 = (this.par_H2 * (((temp_scaled * this.par_H4) / 100) 
                  + (((temp_scaled * ((temp_scaled * this.par_H5) / 100)) >> 6) / 100) 
                  + 16384)) >> 10;
        var1 = var1 * var2;
        var2 = (this.par_H6 * 16384) + (this.par_H7 * temp_scaled) / 2;
        var2 = var2 >> 9;
        const var3 = (var1 >> 14) * (var1 >> 14);
        const var4 = (var2 * var3) >> 15;
        const H = ((var1 + var4) >> 10) * 1000 >> 12;
        // Convert to percentage and clamp
        let humidity = H / 1000;
        if (humidity > 100) humidity = 100;
        if (humidity < 0) humidity = 0;
        return humidity;
    }

    /**
     * Classify gas resistance into a 0–5 air quality level.
     *
     * Based on observed BME680 gas resistance bands (community data from
     * Pimoroni, G6EJD, Home Assistant). These are approximate and assume
     * the sensor heater has been running for at least 5 minutes.
     *
     * 5 = Excellent  (> 400 kΩ) — clean outdoor air or very well ventilated
     * 4 = Good       (> 250 kΩ) — normal clean indoor air
     * 3 = Fair       (> 150 kΩ) — acceptable, typical lived-in room
     * 2 = Poor       (> 75 kΩ)  — stale air, ventilation recommended
     * 1 = Bad        (> 25 kΩ)  — significant VOC presence
     * 0 = Hazardous  (≤ 25 kΩ)  — heavily polluted, investigate immediately
     */
    private classifyAirQuality(gasResistance: number): number {
        if (gasResistance > 400000) return 5;
        if (gasResistance > 250000) return 4;
        if (gasResistance > 150000) return 3;
        if (gasResistance > 75000) return 2;
        if (gasResistance > 25000) return 1;
        return 0;
    }

  /**
   *  Gas resistance compensation (BME680 datasheet - 3.12).
   *  @param adc_gas - Raw 10-bit gas ADC.
   *  @param gas_range - Gas range index (0–15).
   *  @returns Gas resistance in Ω.
   */
    private compensateGas(adc_gas: number, gas_range: number): number {
        // Look-up tables from the BME680 datasheet for gas resistance calculation
        const lookupTable1 = [
            2147483647, 2147483647, 2147483647, 2147483647,
            2147483647, 2126008810, 2147483647, 2130303777,
            2147483647, 2147483647, 2143188679, 2136746228,
            2147483647, 2126008810, 2147483647, 2147483647
        ];
        const lookupTable2 = [
            4096000000, 2048000000, 1024000000, 512000000,
            255744255, 127110228, 64000000, 32258064,
            16016016, 8000000, 4000000, 2000000,
            1000000, 500000, 250000, 125000
        ];
        // Intermediate calculations
        const var1 = ((1340 + 5 * this.range_sw_err) * lookupTable1[gas_range]) / 65536;
        const var2 = (adc_gas * 32768) - 16777216 + var1;
        const var3 = (lookupTable2[gas_range] * var1) / 512;
        const gas_resistance = (var3 + var2 / 2) / var2;
        return Math.floor(gas_resistance);  // in Ohms
    }
}

export default BME680;