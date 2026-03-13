/*
 *  AS7331 - UVA/B/C spectrum sensor
 *  A TypeScript implementation for interfacing with the AS7331 
 *  spectral sensor via I2C.
 * 
 *  by Sanne 'SpuQ' Santens, late 2024
 *  Rewritten February 2026 — corrected register map, OSR state machine,
 *  and irradiance conversion per AS7331 datasheet.
 */
import { openPromisified, PromisifiedBus } from 'i2c-bus';

/**
 * AS7331 spectral UV sensor driver for Raspberry Pi (Node.js).
 *
 * Measures UVA, UVB, and UVC irradiance in µW/cm², plus die temperature in °C,
 * via I²C. The device has two register maps selected by the DOS field in the
 * Operational State Register (OSR):
 *
 *   Configuration State (DOS=10): 8-bit config registers at 0x00–0x07
 *   Measurement State  (DOS=11): 8-bit status + 16-bit LE results at 0x02–0x09
 *
 * References: AS7331 Datasheet §4–§7
 *   https://look.ams-osram.com/m/1856fd2c69c35605/original/AS7331-Spectral-UVA-B-C-Sensor.pdf
 */
export default class AS7331 {
  private i2c!: PromisifiedBus;
  private address: number;
  private busNumber: number = 1;

  private gainCode!: number;
  private timeCode!: number;
  private gainFactor!: number;      // numeric gain multiplier (2^gainCode)
  private integrationTimeMs!: number; // integration time in ms (2^timeCode)

  /* ── Register addresses ─────────────────────────────────────────────────── */

  // Configuration State registers (8-bit)
  private static readonly REG_OSR   = 0x00; // Operational State Register
  private static readonly REG_AGEN  = 0x01; // Device ID / revision
  private static readonly REG_CREG1 = 0x02; // GAIN[7:4] | TIME[3:0]
  private static readonly REG_CREG2 = 0x03; // EN_TM | EN_DIV | DIV[5:0]
  private static readonly REG_CREG3 = 0x04; // MMODE[7:6] | SB | RDYOD | xx | CCLK[1:0]
  private static readonly REG_BREAK = 0x05; // Break time
  private static readonly REG_EDGES = 0x06; // Edge count (SYNS/SYND modes)
  private static readonly REG_OPTREG= 0x07; // Optional settings

  // Measurement State registers (byte addresses; results are 16-bit LE)
  private static readonly REG_STATUS = 0x01; // Status flags (8-bit)
  private static readonly REG_TEMP   = 0x02; // Die temperature   (16-bit LE: 0x02–0x03)
  private static readonly REG_MRES1  = 0x04; // UVA raw count     (16-bit LE: 0x04–0x05)
  private static readonly REG_MRES2  = 0x06; // UVB raw count     (16-bit LE: 0x06–0x07)
  private static readonly REG_MRES3  = 0x08; // UVC raw count     (16-bit LE: 0x08–0x09)

  /* ── OSR bit definitions ────────────────────────────────────────────────── */
  //  Bit 7:4  DEVICE_ID (read-only; should be 0x2 for AS7331)
  //  Bit 3    SS   — Start/Stop (set to 1 to trigger CMD measurement)
  //  Bit 2:1  DOS  — Device Operating State (00=Off, 10=Config, 11=Measurement)
  //  Bit 0    PD   — Power Down

  private static readonly OSR_DOS_CONFIG = 0x04; // DOS=10  → Configuration State
  private static readonly OSR_DOS_MEAS   = 0x06; // DOS=11  → Measurement State
  private static readonly OSR_SS         = 0x08; // SS=1    → Start one-shot

  /* ── Status bit ─────────────────────────────────────────────────────────── */
  private static readonly STATUS_NDATA   = 0x04; // Bit 2: new data available

  /* ── Channel sensitivity (CCLK = 1.024 MHz) ────────────────────────────── *
   *  Datasheet §7.4 — spectral responsivity.                                 *
   *  Units: counts per (µW/cm²) per unit gain per ms of integration.         *
   *  These are *typical* values; for precision, calibrate per-device.         */
  private static readonly SENS_A = 304.0e-3; // UVA  (365 nm peak)
  private static readonly SENS_B = 398.0e-3; // UVB  (310 nm peak)
  private static readonly SENS_C = 855.0e-3; // UVC  (260 nm peak)

  /**
   * Create a new AS7331 driver instance.
   * @param address - 7-bit I²C address (default 0x74).
   */
  constructor(address: number) {
    this.address = address;
  }

  /**
   * Initialize sensor: enter Configuration State, verify device ID, set gain,
   * integration time, and CMD measurement mode with 1.024 MHz conversion clock.
   *
   * @param gainCode  4-bit gain code (0–11). Gain factor = 2^code  (1×–2048×).
   * @param timeCode  4-bit time code (0–14). Integration time = 2^code ms (1–16384 ms).
   */
  public async init(
    gainCode: number = 7,
    timeCode: number = 7
  ): Promise<void> {
    this.i2c = await openPromisified(this.busNumber);

    this.gainCode = gainCode & 0x0F;
    this.timeCode = timeCode & 0x0F;
    this.gainFactor = Math.pow(2, this.gainCode);
    this.integrationTimeMs = Math.pow(2, this.timeCode);

    // 1. Enter Configuration State (DOS=10)
    await this.writeOSR(AS7331.OSR_DOS_CONFIG);
    await this.delay(10);

    // 2. Verify device ID via AGEN register (upper nibble should be 0x2)
    const agen = await this.i2c.readByte(this.address, AS7331.REG_AGEN);
    const deviceId = (agen >> 4) & 0x0F;
    if (deviceId !== 0x02) {
      console.warn(
        `AS7331: unexpected device ID 0x${deviceId.toString(16)} at ` +
        `address 0x${this.address.toString(16)} (expected 0x2)`
      );
    }

    // 3. CREG1: pack GAIN into upper nibble, TIME into lower nibble
    const creg1 = (this.gainCode << 4) | this.timeCode;
    await this.i2c.writeByte(this.address, AS7331.REG_CREG1, creg1);

    // 4. CREG3: MMODE=CMD (00), SB=0, RDYOD=0, CCLK=1.024 MHz (00)
    await this.i2c.writeByte(this.address, AS7331.REG_CREG3, 0x00);

    console.log(
      `AS7331 initialized (ID=0x${agen.toString(16)}): ` +
      `gain=${this.gainFactor}×, tint=${this.integrationTimeMs} ms`
    );
  }

  /**
   * Trigger a one-shot (CMD) measurement and read UVA, UVB, UVC, and die temperature.
   * @returns An object with:
   *  - `uva`, `uvb`, `uvc`: irradiance in µW/cm²
   *  - `temperature`: die temperature in °C
   */
  public async read(): Promise<{
    uva: number;
    uvb: number;
    uvc: number;
    temperature: number;
  }> {
    // 1. Start one-shot measurement: switch to Measurement State with SS=1
    await this.writeOSR(AS7331.OSR_DOS_MEAS | AS7331.OSR_SS);

    // 2. Wait for conversion to complete (integration time + processing margin)
    await this.delay(this.integrationTimeMs + 20);

    // 3. Poll STATUS register until NDATA indicates results are ready (with timeout)
    await this.waitForData(500);

    // 4. Block-read 8 bytes starting at TEMP register:
    //    TEMP(2) + MRES1/UVA(2) + MRES2/UVB(2) + MRES3/UVC(2)
    const buf = Buffer.alloc(8);
    await this.i2c.readI2cBlock(this.address, AS7331.REG_TEMP, 8, buf);

    const tempRaw = buf.readUInt16LE(0);
    const uvaRaw  = buf.readUInt16LE(2);
    const uvbRaw  = buf.readUInt16LE(4);
    const uvcRaw  = buf.readUInt16LE(6);

    // 5. Return to Configuration State for next cycle
    await this.writeOSR(AS7331.OSR_DOS_CONFIG);

    // 6. Convert raw values to physical units
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
   *
   * Datasheet §7.4:
   *   E [µW/cm²] = raw / (sensitivity × gain × t_int_ms)
   *
   * where sensitivity is in counts / (µW/cm² · gain · ms).
   */
  private rawToIrradiance(raw: number, sensitivity: number): number {
    if (raw === 0 || sensitivity === 0) return 0;
    return raw / (sensitivity * this.gainFactor * this.integrationTimeMs);
  }

  /**
   * Convert raw temperature register → °C.
   *
   * Datasheet §7.5:
   *   T [°C] = TEMP_RAW / 256 − 40
   *
   * Note: verify this formula against your specific hardware revision.
   */
  private rawToTemperature(raw: number): number {
    return (raw / 256) - 40;
  }

  /* ── I²C helpers ────────────────────────────────────────────────────────── */

  /**
   * Write the Operational State Register.
   */
  private async writeOSR(value: number): Promise<void> {
    await this.i2c.writeByte(this.address, AS7331.REG_OSR, value);
  }

  /**
   * Poll the STATUS register for the NDATA bit (new data available).
   * @param timeoutMs  Maximum time to wait before giving up.
   */
  private async waitForData(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await this.i2c.readByte(this.address, AS7331.REG_STATUS);
      if (status & AS7331.STATUS_NDATA) return;
      await this.delay(5);
    }
    console.warn('AS7331: NDATA timeout — reading results anyway');
  }

  /**
   * Async delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
