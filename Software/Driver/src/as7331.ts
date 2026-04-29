/*
 *  AS7331 - UVA/B/C spectrum sensor with auto-range
 *  A TypeScript implementation for interfacing with the AS7331
 *  spectral sensor via I2C.
 *
 *  by Sanne 'SpuQ' Santens, February 2026
 *  Based on SparkFun AS7331 Arduino Library
 */
import { openPromisified, PromisifiedBus } from 'i2c-bus';

/**
 * One rung of the auto-range ladder. Each rung is a (gainCode, timeCode)
 * pair that maps to a CREG1 value. Rungs are ordered from least to most
 * sensitive (lowest to highest gain × tconv product).
 */
interface SensitivityLevel {
  gainCode: number; // CREG1[7:4], 0..11 → gain factor 2^(11-gainCode)
  timeCode: number; // CREG1[3:0], 0..15 → tconv 2^timeCode ms
}

/**
 * Result of an AS7331 measurement, including auto-range diagnostics.
 */
export interface AS7331Reading {
  uva: number;             // UVA irradiance (raw / (sens × gain × tint))
  uvb: number;             // UVB irradiance
  uvc: number;             // UVC irradiance
  temperature: number;     // °C
  gain: number;            // Final gain factor used for the accepted reading
  integrationTime: number; // Final integration time (ms) used
  rawMax: number;          // Largest raw count among UVA/UVB/UVC
  iterations: number;      // Number of measurement iterations performed
  saturated: boolean;      // True if even minimum sensitivity could not avoid saturation
}

/**
 * AS7331 spectral UV sensor driver for Raspberry Pi (Node.js).
 *
 * KEY INSIGHT: The AS7331 has TWO register maps that share the same addresses:
 *   - Configuration State (DOS=0b010): Write config registers at 0x00-0x0B
 *   - Measurement State  (DOS=0b011): Read measurement results at 0x00-0x06
 *
 * You MUST switch modes to access the correct registers!
 *
 * AUTO-RANGE: read() automatically adjusts the gain to keep the ADC in a
 * usable window (raw counts in [RAW_LOW_THRESHOLD, RAW_SATURATION)). The
 * "good" rung from the previous call is remembered and used as the starting
 * point for the next call, so steady-state scenes converge in a single
 * iteration.
 *
 * References: AS7331 Datasheet + SparkFun Arduino Library
 */
export default class AS7331 {
  private i2c!: PromisifiedBus;
  private address: number;
  private busNumber: number = 1;

  // Currently configured gain/time (mirrors CREG1 on the device)
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
  private static readonly OSR_SS   = 1 << 7; // Start measurement bit

  // Measurement mode (for CREG3)
  private static readonly MMODE_CMD = 0b01; // Command/one-shot mode (bits 7:6)

  /* ── Channel full-scale irradiance ─────────────────────────── *
   *  Datasheet §7.4 Equation 3 / Table "Irradiance Responsivity":             *
   *    E[µW/cm²] = raw × FSRλ / (gain × tconv[ms] × cclk[kHz])                  *
   *  FSRλ is the irradiance that produces a full-scale count at gain=1×,        *
   *  tconv=1 ms, cclk=1.024 MHz.                                                */
  private static readonly FSR_A = 348160.0; // UVA (365 nm), µW/cm²
  private static readonly FSR_B = 387072.0; // UVB (310 nm), µW/cm²
  private static readonly FSR_C = 169984.0; // UVC (260 nm), µW/cm²
  // cclk in kHz for cclkCode=0 (1.024 MHz). Re-compute if cclk is changed.
  private static readonly CCLK_KHZ = 1024;

  /* ── Auto-range configuration ──────────────────────────────────────────── *
   *  The ladder fixes integration time at 128 ms (timeCode=7) and varies     *
   *  only the gain across its full range (1× … 2048×). 12 rungs × 16-bit     *
   *  ADC give ~27 bits of dynamic range, plenty for vivarium UV bulb         *
   *  monitoring while keeping every conversion ~128 ms regardless of rung.   */
  private static readonly LADDER: SensitivityLevel[] = [
    { gainCode: 11, timeCode: 7 }, // 1×    × 128 ms (least sensitive)
    { gainCode: 10, timeCode: 7 }, // 2×    × 128 ms
    { gainCode:  9, timeCode: 7 }, // 4×    × 128 ms
    { gainCode:  8, timeCode: 7 }, // 8×    × 128 ms
    { gainCode:  7, timeCode: 7 }, // 16×   × 128 ms (legacy default)
    { gainCode:  6, timeCode: 7 }, // 32×   × 128 ms
    { gainCode:  5, timeCode: 7 }, // 64×   × 128 ms
    { gainCode:  4, timeCode: 7 }, // 128×  × 128 ms
    { gainCode:  3, timeCode: 7 }, // 256×  × 128 ms
    { gainCode:  2, timeCode: 7 }, // 512×  × 128 ms
    { gainCode:  1, timeCode: 7 }, // 1024× × 128 ms
    { gainCode:  0, timeCode: 7 }, // 2048× × 128 ms (most sensitive)
  ];

  // Step DOWN the ladder (decrement) when any channel ≥ this raw count
  private static readonly RAW_SATURATION = 65000;
  // Step UP the ladder (increment) when the strongest channel < this
  private static readonly RAW_LOW_THRESHOLD = 512;
  // Hard cap on auto-range iterations per read() call
  private static readonly MAX_AUTORANGE_ITERATIONS = 6;

  // Persistent: index into LADDER, points at the "good" rung from the last
  // measurement. The next read() starts from this rung.
  private ladderIndex: number = 4;

  constructor(address: number) {
    this.address = address;
  }

  /**
   * Initialize sensor: set gain, integration time, and CMD measurement mode.
   * The (gainCode, timeCode) parameters seed the auto-range ladder; if they
   * do not match a ladder rung exactly, the closest rung in log-sensitivity
   * is selected and applied to the device.
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

    // 3. Snap requested gain/time onto the ladder so internal state always
    //    matches a known rung.
    this.ladderIndex = this.findClosestLadderIndex(this.gainCode, this.timeCode);
    const rung = AS7331.LADDER[this.ladderIndex];
    this.gainCode = rung.gainCode;
    this.timeCode = rung.timeCode;
    this.gainFactor = Math.pow(2, 11 - this.gainCode);
    this.integrationTimeMs = Math.pow(2, this.timeCode);

    // 4. Write CREG1: GAIN[7:4] | TIME[3:0]
    await this.writeCReg1(this.gainCode, this.timeCode);

    // 5. Write CREG3: MMODE=CMD (0b01), CCLK=1.024MHz (0b00)
    // CREG3: MMODE[7:6]=01 | SB[4]=0 | RDYOD[3]=0 | CCLK[1:0]=00
    const creg3 = (AS7331.MMODE_CMD << 6) | (this.cclkCode & 0x03);
    await this.i2c.writeByte(this.address, AS7331.REG_CREG3, creg3);

    console.log(
      `AS7331 initialized: gain=${this.gainFactor}×, ` +
      `tint=${this.integrationTimeMs}ms, cclk=1.024MHz, ` +
      `ladder=${this.ladderIndex + 1}/${AS7331.LADDER.length}`
    );
  }

  /**
   * Trigger one or more one-shot (CMD) measurements with auto-ranging
   * and read UVA, UVB, UVC, and temperature. Starts from the previous
   * good rung (`ladderIndex`) and adjusts gain on saturation/under-range
   * until the strongest UV channel falls inside the usable ADC window.
   */
  public async read(): Promise<AS7331Reading> {
    let iterations = 0;
    let raw = { uvaRaw: 0, uvbRaw: 0, uvcRaw: 0, tempRaw: 0 };
    let saturated = false;
    let accepted = false;

    while (iterations < AS7331.MAX_AUTORANGE_ITERATIONS) {
      // Sync the device to whatever rung we currently want
      const target = AS7331.LADDER[this.ladderIndex];
      if (target.gainCode !== this.gainCode || target.timeCode !== this.timeCode) {
        await this.applyLadder(target.gainCode, target.timeCode);
      }

      raw = await this.measureRaw();
      iterations++;

      const maxRaw = Math.max(raw.uvaRaw, raw.uvbRaw, raw.uvcRaw);

      // Saturation → step DOWN the ladder (less sensitive)
      if (maxRaw >= AS7331.RAW_SATURATION) {
        if (this.ladderIndex > 0) {
          this.ladderIndex--;
          continue;
        }
        // Already at minimum sensitivity; record as saturated and stop
        saturated = true;
        accepted = true;
        break;
      }

      // Under-range → step UP the ladder (more sensitive)
      if (
        maxRaw < AS7331.RAW_LOW_THRESHOLD &&
        this.ladderIndex < AS7331.LADDER.length - 1
      ) {
        this.ladderIndex++;
        continue;
      }

      // Reading is inside the usable window (or we've hit a ladder edge).
      accepted = true;
      break;
    }

    const maxRaw = Math.max(raw.uvaRaw, raw.uvbRaw, raw.uvcRaw);
    if (!accepted) {
      // Used up our iteration budget without converging; fall through with
      // whatever we have so the caller still gets numbers (best effort).
    }

    return {
      uva:             this.rawToIrradiance(raw.uvaRaw, AS7331.FSR_A),
      uvb:             this.rawToIrradiance(raw.uvbRaw, AS7331.FSR_B),
      uvc:             this.rawToIrradiance(raw.uvcRaw, AS7331.FSR_C),
      temperature:     this.rawToTemperature(raw.tempRaw),
      gain:            this.gainFactor,
      integrationTime: this.integrationTimeMs,
      rawMax:          maxRaw,
      iterations,
      saturated,
    };
  }

  /* ── Internal helpers ─────────────────────────────────────────────────── */

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
   * Switch into CFG mode, write a new (gainCode, timeCode) to CREG1, and
   * update local state. The next OSR write with DOS=MEAS|SS=1 will leave
   * CFG mode and start the conversion.
   */
  private async applyLadder(gainCode: number, timeCode: number): Promise<void> {
    await this.setOperationMode(AS7331.DOS_CFG);
    await this.writeCReg1(gainCode, timeCode);
    this.gainCode = gainCode;
    this.timeCode = timeCode;
    this.gainFactor = Math.pow(2, 11 - gainCode);
    this.integrationTimeMs = Math.pow(2, timeCode);
  }

  private async writeCReg1(gainCode: number, timeCode: number): Promise<void> {
    const creg1 = ((gainCode & 0x0F) << 4) | (timeCode & 0x0F);
    await this.i2c.writeByte(this.address, AS7331.REG_CREG1, creg1);
  }

  /**
   * Trigger a single measurement at the currently configured gain/time
   * and read back temperature + UVA/UVB/UVC raw counts.
   */
  private async measureRaw(): Promise<{
    uvaRaw: number;
    uvbRaw: number;
    uvcRaw: number;
    tempRaw: number;
  }> {
    // 1. Switch to Measurement State and start measurement.
    //    Setting SS (bit 7) and DOS=0b011 in one write moves us out of CFG
    //    (if we were there) and starts the conversion in CMD mode.
    const osrStart = AS7331.OSR_SS | AS7331.DOS_MEAS;
    await this.i2c.writeByte(this.address, AS7331.REG_OSR, osrStart);

    // 2. Wait for conversion (integration time + processing margin).
    //    Polling NDATA is unreliable in CMD mode, so we just wait.
    await this.delay(this.integrationTimeMs + 50);

    // 3. Read measurement registers separately.
    //    The datasheet doesn't guarantee auto-increment across TEMP→MRES.
    const tempBuf = Buffer.alloc(2);
    await this.i2c.readI2cBlock(this.address, AS7331.REG_MEAS_TEMP, 2, tempBuf);
    const tempRaw = tempBuf.readUInt16LE(0);

    const uvBuf = Buffer.alloc(6);
    await this.i2c.readI2cBlock(this.address, AS7331.REG_MEAS_MRES1, 6, uvBuf);
    const uvaRaw = uvBuf.readUInt16LE(0);
    const uvbRaw = uvBuf.readUInt16LE(2);
    const uvcRaw = uvBuf.readUInt16LE(4);

    return { uvaRaw, uvbRaw, uvcRaw, tempRaw };
  }

  /**
   * Find the ladder rung whose sensitivity (gain × tconv) most closely
   * matches the requested (gainCode, timeCode), measured in log-2 space
   * so the choice is symmetric across factor-of-2 steps.
   */
  private findClosestLadderIndex(gainCode: number, timeCode: number): number {
    // Exact match first
    const exact = AS7331.LADDER.findIndex(
      l => l.gainCode === gainCode && l.timeCode === timeCode
    );
    if (exact >= 0) return exact;

    // Compare in log-2 sensitivity space:
    //   log2(gain × tconv) = (11 - gainCode) + timeCode
    const requested = (11 - gainCode) + timeCode;
    let bestIdx = 0;
    let bestDiff = Infinity;
    AS7331.LADDER.forEach((l, i) => {
      const diff = Math.abs(((11 - l.gainCode) + l.timeCode) - requested);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    return bestIdx;
  }

  /* ── Conversion helpers ─────────────────────────────────────────────────── */

  /**
   * Convert raw channel count → irradiance (µW/cm²).
   * Datasheet §7.4 Equation 3:
   *   E = raw × FSRλ / (gain × tconv[ms] × cclk[kHz])
   */
  private rawToIrradiance(raw: number, fsr: number): number {
    if (raw === 0) return 0;
    return (raw * fsr) /
           (this.gainFactor * this.integrationTimeMs * AS7331.CCLK_KHZ);
  }

  /**
   * Convert raw temperature register → °C.
   * Datasheet: T_chip [°C] = TEMP_RAW × 0.05 − 66.9
   * (e.g. raw = 0x922 = 2338 → 50.0 °C)
   */
  private rawToTemperature(raw: number): number {
    return (raw * 0.05) - 66.9;
  }

  /**
   * Async delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
