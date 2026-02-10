/*
 *  AS7331 - UVA/B/C spectrum sensor (CORRECTED IMPLEMENTATION)
 *  A TypeScript implementation for interfacing with the AS7331 
 *  spectral sensor via I2C.
 * 
 *  by Sanne 'SpuQ' Santens, February 2026
 *  Based on SparkFun AS7331 Arduino Library
 */
import { openPromisified, PromisifiedBus } from 'i2c-bus';

/**
 * AS7331 spectral UV sensor driver for Raspberry Pi (Node.js).
 *
 * KEY INSIGHT: The AS7331 has TWO register maps that share the same addresses:
 *   - Configuration State (DOS=0b010): Write config registers at 0x00-0x0B
 *   - Measurement State  (DOS=0b011): Read measurement results at 0x00-0x06
 * 
 * You MUST switch modes to access the correct registers!
 *
 * References: AS7331 Datasheet + SparkFun Arduino Library
 */
export default class AS7331 {
  private i2c!: PromisifiedBus;
  private address: number;
  private busNumber: number = 1;

  private gainCode!: number;
  private timeCode!: number;
  private gainFactor!: number;        // 2^(11-gainCode)
  private integrationTimeMs!: number; // 2^timeCode ms
  private cclkCode!: number;          // Conversion clock setting

  /* ── Register addresses (MODE-DEPENDENT!) ──────────────────────────────── */
  
  // Configuration State registers (DOS=0b010)
  private static readonly REG_OSR   = 0x00; // Operational State Register (both modes!)
  private static readonly REG_AGEN  = 0x02; // Device ID (CFG mode only)
  private static readonly REG_CREG1 = 0x06; // GAIN[7:4] | TIME[3:0]
  private static readonly REG_CREG2 = 0x07; // EN_TM | EN_DIV | DIV[5:0]
  private static readonly REG_CREG3 = 0x08; // MMODE[7:6] | ... | CCLK[1:0]
  
  // Measurement State registers (DOS=0b011) - SAME ADDRESSES, DIFFERENT MEANINGS!
  private static readonly REG_MEAS_TEMP  = 0x01; // 16-bit temperature (MEAS mode)
  private static readonly REG_MEAS_MRES1 = 0x02; // 16-bit UVA (MEAS mode)
  private static readonly REG_MEAS_MRES2 = 0x03; // 16-bit UVB (MEAS mode)
  private static readonly REG_MEAS_MRES3 = 0x04; // 16-bit UVC (MEAS mode)

  /* ── OSR bit definitions ────────────────────────────────────────────────── */
  // DOS field (bits 2:0) - Device Operating State
  private static readonly DOS_CFG  = 0b010; // Configuration State
  private static readonly DOS_MEAS = 0b011; // Measurement State
  
  // Measurement mode (for CREG3)
  private static readonly MMODE_CMD = 0b01; // Command/one-shot mode (bits 7:6)

  /* ── Channel sensitivity (CCLK = 1.024 MHz) ────────────────────────────── *
   *  Datasheet §7.4 — counts per (µW/cm²) per unit gain per ms              */
  private static readonly SENS_A = 304.0e-3; // UVA (365 nm)
  private static readonly SENS_B = 398.0e-3; // UVB (310 nm)
  private static readonly SENS_C = 855.0e-3; // UVC (260 nm)

  constructor(address: number) {
    this.address = address;
  }

  /**
   * Initialize sensor: set gain, integration time, and CMD measurement mode.
   */
  public async init(
    gainCode: number = 7,   // GAIN_128 (default moderate)
    timeCode: number = 7    // TIME_128MS (default moderate)
  ): Promise<void> {
    this.i2c = await openPromisified(this.busNumber);

    this.gainCode = gainCode & 0x0F;
    this.timeCode = timeCode & 0x0F;
    this.cclkCode = 0; // 1.024 MHz
    this.gainFactor = Math.pow(2, 11 - this.gainCode);
    this.integrationTimeMs = Math.pow(2, this.timeCode);

    // 1. Switch to Configuration State
    await this.setOperationMode(AS7331.DOS_CFG);
    await this.delay(10);

    // 2. Verify device ID (in CFG mode, AGEN register should return 0x2X)
    const agen = await this.i2c.readByte(this.address, AS7331.REG_AGEN);
    const deviceId = (agen >> 4) & 0x0F;
    console.log(
      `AS7331 AGEN register: 0x${agen.toString(16)} ` +
      `(DevID: 0x${deviceId.toString(16)}, expected 0x2)`
    );

    // 3. Write CREG1: GAIN[7:4] | TIME[3:0]
    const creg1 = (this.gainCode << 4) | this.timeCode;
    await this.i2c.writeByte(this.address, AS7331.REG_CREG1, creg1);

    // 4. Write CREG3: MMODE=CMD (0b01), CCLK=1.024MHz (0b00)
    // CREG3: MMODE[7:6]=01 | SB[4]=0 | RDYOD[3]=0 | CCLK[1:0]=00
    const creg3 = (AS7331.MMODE_CMD << 6) | (this.cclkCode & 0x03);
    await this.i2c.writeByte(this.address, AS7331.REG_CREG3, creg3);

    console.log(
      `AS7331 initialized: gain=${this.gainFactor}×, ` +
      `tint=${this.integrationTimeMs}ms, cclk=1.024MHz`
    );
  }

  /**
   * Switch between Configuration and Measurement operating modes.
   */
  private async setOperationMode(mode: number): Promise<void> {
    // Read current OSR value
    const osr = await this.i2c.readByte(this.address, AS7331.REG_OSR);
    
    // Clear DOS field (bits 2:0) and set new mode
    const newOsr = (osr & 0xF8) | (mode & 0x07);
    
    await this.i2c.writeByte(this.address, AS7331.REG_OSR, newOsr);
    
    // Small delay for mode transition
    await this.delay(5);
  }

  /**
   * Trigger a one-shot (CMD) measurement and read UVA, UVB, UVC, and temperature.
   */
  public async read(): Promise<{
    uva: number;
    uvb: number;
    uvc: number;
    temperature: number;
  }> {
    // 1. Switch to Measurement State and start measurement
    //    Setting SS (bit 7) and DOS=0b011 starts measurement in CMD mode
    const osr_start = (1 << 7) | AS7331.DOS_MEAS; // SS=1, DOS=011
    await this.i2c.writeByte(this.address, AS7331.REG_OSR, osr_start);

    // 2. Wait for conversion (integration time + processing margin)
    // Note: polling NDATA status is unreliable, so we just wait
    await this.delay(this.integrationTimeMs + 50);

    // 3. Read measurement registers separately
    //    The datasheet doesn't guarantee auto-increment across TEMP→MRES boundary!
    //    Read TEMP (2 bytes from 0x01)
    const tempBuf = Buffer.alloc(2);
    await this.i2c.readI2cBlock(this.address, AS7331.REG_MEAS_TEMP, 2, tempBuf);
    const tempRaw = tempBuf.readUInt16LE(0);

    //    Read UV channels (6 bytes from 0x02: MRES1 + MRES2 + MRES3)
    const uvBuf = Buffer.alloc(6);
    await this.i2c.readI2cBlock(this.address, AS7331.REG_MEAS_MRES1, 6, uvBuf);
    const uvaRaw = uvBuf.readUInt16LE(0);
    const uvbRaw = uvBuf.readUInt16LE(2);
    const uvcRaw = uvBuf.readUInt16LE(4);

    // 4. Convert raw values to physical units
    return {
      uva:         this.rawToIrradiance(uvaRaw, AS7331.SENS_A),
      uvb:         this.rawToIrradiance(uvbRaw, AS7331.SENS_B),
      uvc:         this.rawToIrradiance(uvcRaw, AS7331.SENS_C),
      temperature: this.rawToTemperature(tempRaw),
    };
  }

  /* ── Conversion helpers ─────────────────────────────────────────────────── */

  /**
   * Convert raw channel count → irradiance (µW/cm²).
   * Equation: E = raw / (sensitivity × gain × tint_ms)
   */
  private rawToIrradiance(raw: number, sensitivity: number): number {
    if (raw === 0 || sensitivity === 0) return 0;
    return raw / (sensitivity * this.gainFactor * this.integrationTimeMs);
  }

  /**
   * Convert raw temperature register → °C.
   * Formula: T [°C] = (TEMP_RAW / 256) - 40
   */
  private rawToTemperature(raw: number): number {
    return (raw / 256.0) - 40.0;
  }

  /**
   * Async delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
