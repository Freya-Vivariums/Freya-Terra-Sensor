/*
 *  VEML6030 - Ambient Light sensor
 *  A TypeScript implementation for interfacing with the VEML6030 ambient light sensor via I2C.
 * 
 *  by Sanne "SpuQ" Santens, late 2024
 */

import { openPromisified, PromisifiedBus } from 'i2c-bus';

/**
 * Sensitivity setting for VEML6030 autoscale functionality.
 */
interface SensitivitySetting {
  gain: number;          // Gain multiplier (2, 1, 0.25, 0.125)
  gainBits: number;      // 2-bit gain code for register
  it: number;            // Integration time in ms
  itBits: number;        // 4-bit IT code for register
  resolution: number;    // Lux per count
  maxLux: number;        // Maximum detectable lux
}

/**
 * Result from autoRead() method.
 */
export interface AutoReadResult {
  lux: number;
  gain: number;
  integrationTime: number;
  rawCount: number;
  iterations: number;
}

/**
 * VEML6030 ambient light sensor driver for Raspberry Pi (Node.js).
 *
 * Measures ambient light intensity in lux via I²C, following Vishay VEML6030 datasheet (Doc. R101048).
 * Supports configurable gain and integration time, plus >1klux compensation polynomial.
 * Includes autoscaling functionality for optimal sensitivity across wide lux range.
 */
export default class VEML6030 {
  private i2c!: PromisifiedBus;
  private address: number;

  private busNumber: number = 1;
  /**
   * Current ALS gain factor (e.g. 2, 1, 1/4, 1/8).
   * Used in lux conversion formula.
   */
  private gainValue!: number;

  /**
   * Integration time in milliseconds (25, 50, 100, 200, 400, 800).
   */
  private integrationTime!: number;

  /**
   * Scale factor: lux per raw count based on gain & integration time.
   */
  private luxPerCount!: number;

  /**
   * Current gain bits (2-bit code for register 0x00).
   */
  private currentGainBits!: number;

  /**
   * Current integration time bits (4-bit code for register 0x00).
   */
  private currentItBits!: number;

  /**
   * Persistent ladder index for autoRead() method.
   * Default: x1/8 gain, 100ms IT (index 3).
   */
  private ladderIndex: number = 3;

  /**
   * Sensitivity settings ordered from lowest to highest sensitivity (coarsest to finest resolution).
   * Based on Vishay application note document 84367.
   */
  private readonly sensitivitySettings: SensitivitySetting[] = [
    // Lowest sensitivity (coarsest resolution, highest max lux)
    { gain: 0.125, gainBits: 0b10, it: 25,  itBits: 0b1100, resolution: 2.1504, maxLux: 140926 },
    { gain: 0.125, gainBits: 0b10, it: 50,  itBits: 0b1000, resolution: 1.0752, maxLux: 70463 },
    { gain: 0.25,  gainBits: 0b11, it: 25,  itBits: 0b1100, resolution: 1.0752, maxLux: 70463 },
    { gain: 0.125, gainBits: 0b10, it: 100, itBits: 0b0000, resolution: 0.5376, maxLux: 35232 },
    { gain: 0.25,  gainBits: 0b11, it: 50,  itBits: 0b1000, resolution: 0.5376, maxLux: 35232 },
    { gain: 1,     gainBits: 0b01, it: 25,  itBits: 0b1100, resolution: 0.2688, maxLux: 17616 },
    { gain: 0.125, gainBits: 0b10, it: 200, itBits: 0b0001, resolution: 0.2688, maxLux: 17616 },
    { gain: 0.25,  gainBits: 0b11, it: 100, itBits: 0b0000, resolution: 0.2688, maxLux: 17616 },
    { gain: 2,     gainBits: 0b00, it: 25,  itBits: 0b1100, resolution: 0.1344, maxLux: 8808 },
    { gain: 0.125, gainBits: 0b10, it: 400, itBits: 0b0010, resolution: 0.1344, maxLux: 8808 },
    { gain: 0.25,  gainBits: 0b11, it: 200, itBits: 0b0001, resolution: 0.1344, maxLux: 8808 },
    { gain: 1,     gainBits: 0b01, it: 50,  itBits: 0b1000, resolution: 0.1344, maxLux: 8808 },
    { gain: 2,     gainBits: 0b00, it: 50,  itBits: 0b1000, resolution: 0.0672, maxLux: 4404 },
    { gain: 0.125, gainBits: 0b10, it: 800, itBits: 0b0011, resolution: 0.0672, maxLux: 4404 },
    { gain: 0.25,  gainBits: 0b11, it: 400, itBits: 0b0010, resolution: 0.0672, maxLux: 4404 },
    { gain: 1,     gainBits: 0b01, it: 100, itBits: 0b0000, resolution: 0.0672, maxLux: 4404 },
    { gain: 2,     gainBits: 0b00, it: 100, itBits: 0b0000, resolution: 0.0336, maxLux: 2202 },
    { gain: 0.25,  gainBits: 0b11, it: 800, itBits: 0b0011, resolution: 0.0336, maxLux: 2202 },
    { gain: 1,     gainBits: 0b01, it: 200, itBits: 0b0001, resolution: 0.0336, maxLux: 2202 },
    { gain: 2,     gainBits: 0b00, it: 200, itBits: 0b0001, resolution: 0.0168, maxLux: 1101 },
    { gain: 1,     gainBits: 0b01, it: 400, itBits: 0b0010, resolution: 0.0168, maxLux: 1101 },
    { gain: 2,     gainBits: 0b00, it: 400, itBits: 0b0010, resolution: 0.0084, maxLux: 550 },
    { gain: 1,     gainBits: 0b01, it: 800, itBits: 0b0011, resolution: 0.0084, maxLux: 550 },
    { gain: 2,     gainBits: 0b00, it: 800, itBits: 0b0011, resolution: 0.0042, maxLux: 275 }
    // Highest sensitivity (finest resolution, lowest max lux)
  ];

  /**
   * Create a new VEML6030 instance.
   * @param busNumber - I2C bus number (default 1).
   * @param address - 7-bit I2C address (0x48 default, 0x10 if ADDR pin low).
   */
  constructor( address:number) {

    this.address = address;
  }

  /**
   * Initialize sensor: open I2C bus, verify device ID, configure ALS settings.
   * @param gainBits - 2-bit code for ALS gain (00=2×, 01=1×, 11=1/4×, 10=1/8×).
   * @param itBits - 4-bit code for integration time (0000=100ms,0001=200ms,0010=400ms,0011=800ms,1000=50ms,1100=25ms).
   * @throws if device ID mismatch.
   */
  public async init(
    gainBits: number = 0b11,
    itBits: number = 0b0000
  ): Promise<void> {
    // Open I2C bus
    this.i2c = await openPromisified(this.busNumber);

    // Read device ID (reg 0x07 LSB should be 0x81) (§3.2)
    const id = await this.i2c.readWord(this.address, 0x07);
    const idLsb = id & 0xFF;
    if (idLsb !== 0x81) {
      throw new Error(`VEML6030 not found at 0x${this.address.toString(16)}`);
    }

    // Store current settings
    this.currentGainBits = gainBits;
    this.currentItBits = itBits;
    this.gainValue = this.decodeGain(gainBits);
    this.integrationTime = this.decodeIntegrationTime(itBits);
    
    // Initialize ladder index to match current settings
    this.ladderIndex = this.findCurrentSettingIndex();

    // Find matching sensitivity setting for precise resolution
    const setting = this.sensitivitySettings.find(s => 
      s.gainBits === gainBits && s.itBits === itBits
    );
    this.luxPerCount = setting ? setting.resolution : 
      0.0036 * (800 / this.integrationTime) * (2 / this.gainValue);

    // Build 16-bit config: [15..13]=0, [12..11]=gainBits, [10]=0,
    // [9..6]=itBits, [5..4]=00, [3..2]=00, [1]=0, [0]=0
    const cfg = (gainBits << 11) | (itBits << 6);
    await this.i2c.writeWord(this.address, 0x00, cfg);

    // Delay one integration cycle before first read (§IT timing)
    await this.delay(this.integrationTime + 10);
  }

  /**
   * Read ambient light and return lux value using current fixed settings.
   * @returns Object with `lux` (floating-point).
   */
  public async read(): Promise<{ lux: number }> {
    // Read raw ALS data (reg 0x04 LSB then MSB) (§3.8)
    const raw = await this.i2c.readWord(this.address, 0x04);
    const counts = raw & 0xFFFF;

    // Convert to lux
    let lux = counts * this.luxPerCount;

    // Apply high-lux compensation if gain <=1/4 and lux >1000 (§AppNote)
    if (this.gainValue <= 0.25 && lux > 1000) {
      lux = this.compensateHighLux(lux);
    }

    return { lux };
  }

  /**
   * Read ambient light with automatic gain/integration time scaling using a simple ladder algorithm.
   * Steps up the ladder on raw count 0, down on saturation (65535), returns on any other count.
   * @returns Object with lux value, final gain/IT settings, raw count, and iteration count.
   */
  public async autoRead(): Promise<AutoReadResult> {
    let iterations = 0;

    while (true) {
      const setting = this.sensitivitySettings[this.ladderIndex];
      const raw = await this.i2c.readWord(this.address, 0x04);
      const counts = raw & 0xFFFF;
      iterations++;

      if (counts === 0 && this.ladderIndex < this.sensitivitySettings.length - 1) {
        // Too dark — step up the ladder
        this.ladderIndex++;
        const next = this.sensitivitySettings[this.ladderIndex];
        await this.updateSettings(next.gainBits, next.itBits);
        await this.delay(2 * next.it + 10);
        continue;
      }

      if (counts === 65535 && this.ladderIndex > 0) {
        // Saturated — step down the ladder
        this.ladderIndex--;
        const next = this.sensitivitySettings[this.ladderIndex];
        await this.updateSettings(next.gainBits, next.itBits);
        await this.delay(2 * next.it + 10);
        continue;
      }

      // Valid reading (or at the limit of the ladder)
      let lux = counts * setting.resolution;
      if (setting.gain <= 0.25 && lux > 1000) {
        lux = this.compensateHighLux(lux);
      }

      return {
        lux,
        gain: setting.gain,
        integrationTime: setting.it,
        rawCount: counts,
        iterations
      };
    }
  }

  /**
   * Find the index of current gain/IT setting in the sensitivity array.
   */
  private findCurrentSettingIndex(): number {
    const index = this.sensitivitySettings.findIndex(s => 
      s.gainBits === this.currentGainBits && s.itBits === this.currentItBits
    );
    return index >= 0 ? index : 0; // Default to lowest sensitivity if not found
  }

  /**
   * Update sensor configuration with new gain and integration time settings.
   */
  private async updateSettings(gainBits: number, itBits: number): Promise<void> {
    // Only update if settings actually changed
    if (gainBits === this.currentGainBits && itBits === this.currentItBits) {
      return;
    }

    this.currentGainBits = gainBits;
    this.currentItBits = itBits;
    this.gainValue = this.decodeGain(gainBits);
    this.integrationTime = this.decodeIntegrationTime(itBits);
    
    // Find matching sensitivity setting for precise resolution
    const setting = this.sensitivitySettings.find(s => 
      s.gainBits === gainBits && s.itBits === itBits
    );
    this.luxPerCount = setting ? setting.resolution : 
      0.0036 * (800 / this.integrationTime) * (2 / this.gainValue);

    // Build and write new config
    const cfg = (gainBits << 11) | (itBits << 6);
    await this.i2c.writeWord(this.address, 0x00, cfg);
  }

  /**
   * Decode gain code to factor.
   * @param bits - 2-bit gain code.
   */
  private decodeGain(bits: number): number {
    switch (bits & 0b11) {
      case 0b00:
        return 2;
      case 0b01:
        return 1;
      case 0b11:
        return 0.25;
      case 0b10:
        return 0.125;
      default:
        return 1;
    }
  }

  /**
   * Decode integration time code to milliseconds.
   * @param bits - 4-bit integration time code.
   */
  private decodeIntegrationTime(bits: number): number {
    switch (bits & 0b1111) {
      case 0b0000:
        return 100;
      case 0b0001:
        return 200;
      case 0b0010:
        return 400;
      case 0b0011:
        return 800;
      case 0b1000:
        return 50;
      case 0b1100:
        return 25;
      default:
        return 100;
    }
  }

  /**
   * Non-linear compensation (>1klux) polynomial (§AppNote).
   * lux_comp = A·lux^4 + B·lux^3 + C·lux^2 + D·lux
   */
  private compensateHighLux(lux: number): number {
    // Coefficients from Vishay app note
    const A = 6.0135e-13;
    const B = -9.3924e-9;
    const C = 8.1488e-5;
    const D = 1.0023;
    return A * Math.pow(lux, 4)
      + B * Math.pow(lux, 3)
      + C * Math.pow(lux, 2)
      + D * lux;
  }

  /**
   * Simple delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
