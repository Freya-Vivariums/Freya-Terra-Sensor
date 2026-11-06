/*
 *  Freya Terra Sensor - PCB functional test
 *
 *  Production test program for the Freya Terra Sensor board (Rev 1.x).
 *  Runs on an Arduino Uno fitted with a Crowtail Base Shield; the sensor board
 *  is connected to one of the shield's I2C sockets with a 4-pin Crowtail cable.
 *
 *  The test runs automatically at power-up and prints a report on the serial
 *  console (9600 baud). The result is also shown on the Arduino's "L" LED:
 *      LED on steadily   -> board PASSED
 *      LED blinking fast -> board FAILED
 *  Send any character from the serial monitor (or press RESET) to repeat the test.
 *
 *  What is tested:
 *    1. I2C bus lines: SDA/SCL pulled up by the board (warning if below 5V), no shorts
 *    2. I2C scan: exactly BME680 (0x76), VEML6030 (0x10) and AS7331 (0x74)
 *    3. BME680: chip ID, calibration data, T/P/RH measurement, gas heater
 *    4. VEML6030: device ID, register write/read-back, ambient light reading
 *    5. AS7331: device ID, register write/read-back, UV conversion, chip temp
 *
 *  No extra libraries are needed (only the built-in Wire library).
 *
 *  Copyright© 2026 Sanne 'SpuQ' Santens
 *  Released under the GNU GPL-3.0 license.
 */

#include <Wire.h>

#define TEST_VERSION  "1.0"
#define SERIAL_BAUD   9600

/* ── I2C addresses ─────────────────────────────────────────────────────── */
const uint8_t ADDR_VEML6030 = 0x10;
const uint8_t ADDR_AS7331   = 0x74;
const uint8_t ADDR_BME680   = 0x76;

/* ── Pass/fail limits (test must run indoors, at room temperature, under
 *    normal room lighting) ────────────────────────────────────────────────── */
const float BUS_IDLE_5V      = 0.85;      // idle SDA/SCL level (fraction of Arduino 5V): bus at 5V
const float BUS_IDLE_MIN     = 0.50;      // below this the bus is unusable; in between (e.g. 3.3V) = warning
const float BME_T_MIN        = 5.0;       // °C
const float BME_T_MAX        = 45.0;
const float BME_P_MIN        = 800.0;     // hPa (sea level ... ~2000 m altitude)
const float BME_P_MAX        = 1100.0;
const float BME_H_MIN        = 5.0;       // %RH
const float BME_H_MAX        = 95.0;
const float BME_GAS_MIN      = 1000.0;    // Ohm
const float BME_GAS_MAX      = 5000000.0;
const uint8_t BME_CYCLES     = 3;         // forced measurements (gas needs a few to settle)
const float BME_HEATER_C     = 320.0;     // gas heater target temperature
const uint16_t BME_HEATER_MS = 150;       // gas heater duration
const float LUX_MIN          = 5.0;       // room light must give at least this
const float AS_T_MIN         = 0.0;       // AS7331 chip temperature, °C
const float AS_T_MAX         = 70.0;

/* On the Uno, SDA/SCL are A4/A5, so the line voltage can be measured with the ADC.
 * On other boards, fall back to a digital (high/low) check. */
#if defined(PIN_WIRE_SDA) && defined(PIN_A4) && defined(PIN_WIRE_SCL) && defined(PIN_A5)
  #if (PIN_WIRE_SDA == PIN_A4) && (PIN_WIRE_SCL == PIN_A5)
    #define BUS_ANALOG 1
  #endif
#endif

/* Types used in function signatures must be declared before the first function:
 * the Arduino IDE inserts its generated function prototypes at that point. */
struct BmeReading {
  bool  done;          // measurement cycle completed
  float temperature;   // °C
  float pressure;      // hPa
  float humidity;      // %RH
  float gas;           // Ohm
  bool  heatStable;    // heater reached target temperature
  bool  gasValid;      // gas conversion valid
};

/* ══════════════════════════════════════════════════════════════════════════
 *  Report formatting
 * ══════════════════════════════════════════════════════════════════════════ */
const uint8_t LABEL_WIDTH = 26;
const uint8_t VALUE_WIDTH = 18;

uint8_t checksRun    = 0;
uint8_t checksFailed = 0;
uint8_t checksWarned = 0;

void line(char c) {
  for (uint8_t i = 0; i < 56; i++) Serial.print(c);
  Serial.println();
}

void heading(uint8_t num, const __FlashStringHelper *title) {
  Serial.println();
  Serial.print('[');
  Serial.print(num);
  Serial.print(F("] "));
  Serial.println(title);
}

// Start a report line: "    label ........ "
void label(const __FlashStringHelper *text) {
  Serial.print(F("    "));
  uint8_t n = Serial.print(text);
  Serial.print(' ');
  for (n++; n < LABEL_WIDTH; n++) Serial.print('.');
  Serial.print(' ');
}

// Finish a report line with PASS/FAIL. 'used' = characters printed as value.
bool result(bool ok, uint8_t used, const __FlashStringHelper *hint) {
  for (; used < VALUE_WIDTH; used++) Serial.print(' ');
  Serial.println(ok ? F("PASS") : F("FAIL  <<<"));
  checksRun++;
  if (!ok) {
    checksFailed++;
    if (hint) {
      Serial.print(F("        -> "));
      Serial.println(hint);
    }
  }
  return ok;
}

// Finish a report line with WARN: the check passes, but test conditions are not ideal.
void warning(uint8_t used, const __FlashStringHelper *hint) {
  for (; used < VALUE_WIDTH; used++) Serial.print(' ');
  Serial.println(F("WARN"));
  checksRun++;
  checksWarned++;
  Serial.print(F("        -> "));
  Serial.println(hint);
}

// Finish an informational report line (not judged).
void info() {
  Serial.println();
}

uint8_t printHex8(uint8_t v) {
  uint8_t n = Serial.print(F("0x"));
  if (v < 0x10) n += Serial.print('0');
  return n + Serial.print(v, HEX);
}

uint8_t printHex16(uint16_t v) {
  uint8_t n = Serial.print(F("0x"));
  for (int8_t shift = 12; shift >= 0; shift -= 4) n += Serial.print((v >> shift) & 0x0F, HEX);
  return n;
}

/* ══════════════════════════════════════════════════════════════════════════
 *  I2C helpers
 * ══════════════════════════════════════════════════════════════════════════ */
bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool i2cWrite8(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool i2cWrite16LE(uint8_t addr, uint8_t reg, uint16_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write((uint8_t)(val & 0xFF));
  Wire.write((uint8_t)(val >> 8));
  return Wire.endTransmission() == 0;
}

bool i2cRead(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;   // repeated start
  if (Wire.requestFrom(addr, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

bool i2cRead8(uint8_t addr, uint8_t reg, uint8_t &val) {
  return i2cRead(addr, reg, &val, 1);
}

bool i2cRead16LE(uint8_t addr, uint8_t reg, uint16_t &val) {
  uint8_t b[2];
  if (!i2cRead(addr, reg, b, 2)) return false;
  val = (uint16_t)b[0] | ((uint16_t)b[1] << 8);
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
 *  1. I2C bus line test (runs with the Wire peripheral disabled)
 * ══════════════════════════════════════════════════════════════════════════ */
void lineRelease(uint8_t pin) { pinMode(pin, INPUT); digitalWrite(pin, LOW); }  // high-Z, no pull-up
void lineLow(uint8_t pin)     { digitalWrite(pin, LOW); pinMode(pin, OUTPUT); }

// Line level as a fraction of the Arduino supply (0.0 ... 1.0)
float readLevel(uint8_t pin) {
#ifdef BUS_ANALOG
  analogRead(pin);                       // dummy conversion after channel switch
  return analogRead(pin) / 1023.0;
#else
  return digitalRead(pin) ? 1.0 : 0.0;
#endif
}

// Discharge the line, release it, and measure where the board's pull-up brings it.
// A line without pull-up stays low; a line with pull-up returns to 5V in microseconds.
float idleLevel(uint8_t pin) {
  lineLow(pin);
  delay(1);
  lineRelease(pin);
  delayMicroseconds(200);
  return readLevel(pin);
}

// Level of 'pin' while 'other' is pulled low (detects SDA-SCL solder bridges)
float levelWhileOtherLow(uint8_t pin, uint8_t other) {
  lineLow(other);
  delayMicroseconds(200);
  float v = readLevel(pin);
  lineRelease(other);
  delayMicroseconds(200);
  return v;
}

// Free the bus in case a device was left mid-transfer (e.g. after an Arduino reset)
void busRecover() {
  lineRelease(SDA);
  lineRelease(SCL);
  delayMicroseconds(10);
  for (uint8_t i = 0; i < 9 && digitalRead(SDA) == LOW; i++) {
    lineLow(SCL);     delayMicroseconds(5);
    lineRelease(SCL); delayMicroseconds(5);
  }
  // STOP condition: SDA rises while SCL is high
  lineLow(SCL);     delayMicroseconds(5);
  lineLow(SDA);     delayMicroseconds(5);
  lineRelease(SCL); delayMicroseconds(5);
  lineRelease(SDA); delayMicroseconds(5);
}

uint8_t printLevel(float level) {
#ifdef BUS_ANALOG
  return Serial.print(level * 5.0, 2) + Serial.print(F(" V"));
#else
  return Serial.print(level > 0.5 ? F("high") : F("low"));
#endif
}

// 5V -> PASS; lower but still a usable logic level (e.g. 3.3V) -> WARN; otherwise FAIL
bool checkIdleLevel(float level, const __FlashStringHelper *failHint) {
  uint8_t n = printLevel(level);
  if (level >= BUS_IDLE_5V || level < BUS_IDLE_MIN) return result(level >= BUS_IDLE_5V, n, failHint);
  warning(n, F("bus below 5V (3.3V supply?): board works, but test conditions are not ideal"));
  return true;
}

bool testBusLines() {
  heading(1, F("I2C bus lines"));
  Wire.end();                              // make sure the TWI peripheral releases the pins
  busRecover();

  bool ok = true;
  label(F("SDA idle level"));
  ok &= checkIdleLevel(idleLevel(SDA), F("SDA not pulled up: board/cable connected? short to GND?"));

  label(F("SCL idle level"));
  ok &= checkIdleLevel(idleLevel(SCL), F("SCL not pulled up: board/cable connected? short to GND?"));

  if (ok) {
    // Only meaningful when both lines idle high
    float sdaWithSclLow = levelWhileOtherLow(SDA, SCL);
    float sclWithSdaLow = levelWhileOtherLow(SCL, SDA);
    bool noBridge = (sdaWithSclLow >= BUS_IDLE_MIN) && (sclWithSdaLow >= BUS_IDLE_MIN);
    label(F("SDA-SCL short"));
    ok &= result(noBridge, Serial.print(noBridge ? F("none") : F("SHORTED")),
                 F("SDA and SCL are connected together: check connector J1 and level shifter area"));
  }

  busRecover();
  return ok;
}

/* ══════════════════════════════════════════════════════════════════════════
 *  2. I2C device scan
 * ══════════════════════════════════════════════════════════════════════════ */
bool hasBME680, hasVEML6030, hasAS7331;

bool testScan() {
  heading(2, F("I2C device scan"));
  hasBME680   = i2cPresent(ADDR_BME680);
  hasVEML6030 = i2cPresent(ADDR_VEML6030);
  hasAS7331   = i2cPresent(ADDR_AS7331);

  bool ok = true;
  label(F("0x76 BME680"));
  ok &= result(hasBME680, Serial.print(hasBME680 ? F("found") : F("missing")),
               F("check U1 (BME680) soldering"));
  label(F("0x10 VEML6030"));
  ok &= result(hasVEML6030, Serial.print(hasVEML6030 ? F("found") : F("missing")),
               F("check U2 (VEML6030) soldering"));
  label(F("0x74 AS7331"));
  ok &= result(hasAS7331, Serial.print(hasAS7331 ? F("found") : F("missing")),
               F("check U4 (AS7331) soldering"));

  // Any other address answering means a wrong address strap or a solder bridge
  uint8_t unexpected[4];
  uint8_t nUnexpected = 0;
  for (uint8_t a = 0x08; a <= 0x77; a++) {
    if (a == ADDR_BME680 || a == ADDR_VEML6030 || a == ADDR_AS7331) continue;
    if (i2cPresent(a)) {
      if (nUnexpected < sizeof(unexpected)) unexpected[nUnexpected] = a;
      nUnexpected++;
    }
  }
  label(F("other addresses"));
  uint8_t n = 0;
  if (nUnexpected == 0) n = Serial.print(F("none"));
  for (uint8_t i = 0; i < nUnexpected && i < sizeof(unexpected); i++) {
    if (i) n += Serial.print(' ');
    n += printHex8(unexpected[i]);
  }
  if (nUnexpected > sizeof(unexpected)) n += Serial.print(F(" ..."));
  ok &= result(nUnexpected == 0, n,
               F("a sensor answers on a wrong address: check address pins / solder bridges"));
  return ok;
}

/* ══════════════════════════════════════════════════════════════════════════
 *  3. BME680 - temperature, humidity, pressure, gas
 *     Compensation formulas: Bosch BME68x reference (floating-point version)
 * ══════════════════════════════════════════════════════════════════════════ */
struct {
  uint16_t t1; int16_t t2; int8_t t3;
  uint16_t p1; int16_t p2; int8_t p3; int16_t p4; int16_t p5;
  int8_t p6; int8_t p7; int16_t p8; int16_t p9; uint8_t p10;
  uint16_t h1; uint16_t h2; int8_t h3; int8_t h4; int8_t h5; uint8_t h6; int8_t h7;
  int8_t gh1; int16_t gh2; int8_t gh3;
  uint8_t resHeatRange; int8_t resHeatVal; int8_t rangeSwErr;
} bmeCal;

float bmeTFine;

bool bmeReadCalibration() {
  uint8_t c[41];
  if (!i2cRead(ADDR_BME680, 0x89, c, 25)) return false;
  if (!i2cRead(ADDR_BME680, 0xE1, c + 25, 16)) return false;
  #define U16(i) ((uint16_t)c[(i) + 1] << 8 | c[(i)])
  bmeCal.t1  = U16(33);
  bmeCal.t2  = (int16_t)U16(1);
  bmeCal.t3  = (int8_t)c[3];
  bmeCal.p1  = U16(5);
  bmeCal.p2  = (int16_t)U16(7);
  bmeCal.p3  = (int8_t)c[9];
  bmeCal.p4  = (int16_t)U16(11);
  bmeCal.p5  = (int16_t)U16(13);
  bmeCal.p7  = (int8_t)c[15];
  bmeCal.p6  = (int8_t)c[16];
  bmeCal.p8  = (int16_t)U16(19);
  bmeCal.p9  = (int16_t)U16(21);
  bmeCal.p10 = c[23];
  bmeCal.h2  = ((uint16_t)c[25] << 4) | (c[26] >> 4);
  bmeCal.h1  = ((uint16_t)c[27] << 4) | (c[26] & 0x0F);
  bmeCal.h3  = (int8_t)c[28];
  bmeCal.h4  = (int8_t)c[29];
  bmeCal.h5  = (int8_t)c[30];
  bmeCal.h6  = c[31];
  bmeCal.h7  = (int8_t)c[32];
  bmeCal.gh2 = (int16_t)U16(35);
  bmeCal.gh1 = (int8_t)c[37];
  bmeCal.gh3 = (int8_t)c[38];
  #undef U16

  uint8_t r;
  if (!i2cRead8(ADDR_BME680, 0x02, r)) return false;
  bmeCal.resHeatRange = (r & 0x30) >> 4;
  if (!i2cRead8(ADDR_BME680, 0x00, r)) return false;
  bmeCal.resHeatVal = (int8_t)r;
  if (!i2cRead8(ADDR_BME680, 0x04, r)) return false;
  bmeCal.rangeSwErr = ((int8_t)(r & 0xF0)) / 16;

  // Blank (0x00) or unreadable (0xFF) calibration memory
  return bmeCal.t1 != 0x0000 && bmeCal.t1 != 0xFFFF && bmeCal.p1 != 0x0000 && bmeCal.p1 != 0xFFFF;
}

float bmeTemperature(uint32_t adc) {
  float v1 = ((float)adc / 16384.0f - (float)bmeCal.t1 / 1024.0f) * (float)bmeCal.t2;
  float d  = (float)adc / 131072.0f - (float)bmeCal.t1 / 8192.0f;
  float v2 = d * d * ((float)bmeCal.t3 * 16.0f);
  bmeTFine = v1 + v2;
  return bmeTFine / 5120.0f;
}

float bmePressure(uint32_t adc) {   // Pa
  float v1 = bmeTFine / 2.0f - 64000.0f;
  float v2 = v1 * v1 * ((float)bmeCal.p6 / 131072.0f);
  v2 = v2 + v1 * (float)bmeCal.p5 * 2.0f;
  v2 = v2 / 4.0f + (float)bmeCal.p4 * 65536.0f;
  v1 = (((float)bmeCal.p3 * v1 * v1) / 16384.0f + (float)bmeCal.p2 * v1) / 524288.0f;
  v1 = (1.0f + v1 / 32768.0f) * (float)bmeCal.p1;
  if ((int)v1 == 0) return 0;
  float p = 1048576.0f - (float)adc;
  p = ((p - v2 / 4096.0f) * 6250.0f) / v1;
  v1 = (float)bmeCal.p9 * p * p / 2147483648.0f;
  v2 = p * ((float)bmeCal.p8 / 32768.0f);
  float v3 = (p / 256.0f) * (p / 256.0f) * (p / 256.0f) * ((float)bmeCal.p10 / 131072.0f);
  return p + (v1 + v2 + v3 + (float)bmeCal.p7 * 128.0f) / 16.0f;
}

float bmeHumidity(uint16_t adc) {
  float t  = bmeTFine / 5120.0f;
  float v1 = (float)adc - ((float)bmeCal.h1 * 16.0f + ((float)bmeCal.h3 / 2.0f) * t);
  float v2 = v1 * (((float)bmeCal.h2 / 262144.0f) *
             (1.0f + ((float)bmeCal.h4 / 16384.0f) * t + ((float)bmeCal.h5 / 1048576.0f) * t * t));
  float v3 = (float)bmeCal.h6 / 16384.0f;
  float v4 = (float)bmeCal.h7 / 2097152.0f;
  float h  = v2 + (v3 + v4 * t) * v2 * v2;
  if (h > 100.0f) h = 100.0f;
  if (h < 0.0f) h = 0.0f;
  return h;
}

float bmeGas(uint16_t adc, uint8_t range) {
  static const float k1[16] = { 0, 0, 0, 0, 0, -1.0, 0, -0.8, 0, 0, -0.2, -0.5, 0, -1.0, 0, 0 };
  static const float k2[16] = { 0, 0, 0, 0, 0.1, 0.7, 0, -0.8, -0.1, 0, 0, 0, 0, 0, 0, 0 };
  float v1 = 1340.0f + 5.0f * (float)bmeCal.rangeSwErr;
  float v2 = v1 * (1.0f + k1[range] / 100.0f);
  float v3 = 1.0f + k2[range] / 100.0f;
  return 1.0f / (v3 * 0.000000125f * (float)(1UL << range) * (((float)adc - 512.0f) / v2 + 1.0f));
}

uint8_t bmeHeaterResistance(float targetC, float ambientC) {
  float v1 = (float)bmeCal.gh1 / 16.0f + 49.0f;
  float v2 = ((float)bmeCal.gh2 / 32768.0f) * 0.0005f + 0.00235f;
  float v3 = (float)bmeCal.gh3 / 1024.0f;
  float v4 = v1 * (1.0f + v2 * targetC);
  float v5 = v4 + v3 * ambientC;
  float r  = 3.4f * ((v5 * (4.0f / (4.0f + (float)bmeCal.resHeatRange)) *
                     (1.0f / (1.0f + (float)bmeCal.resHeatVal * 0.002f))) - 25.0f);
  if (r < 0) r = 0;
  if (r > 255) r = 255;
  return (uint8_t)r;
}

uint8_t bmeGasWait(uint16_t ms) {   // gas_wait_x encoding: 6-bit value x 1/4/16/64
  uint8_t factor = 0;
  if (ms >= 0xFC0) return 0xFF;
  while (ms > 0x3F) { ms /= 4; factor++; }
  return (uint8_t)(ms + factor * 64);
}

BmeReading bmeMeasure(float ambientC) {
  BmeReading r = { false, 0, 0, 0, 0, false, false };
  bool ok = true;
  ok &= i2cWrite8(ADDR_BME680, 0x5A, bmeHeaterResistance(BME_HEATER_C, ambientC)); // res_heat_0
  ok &= i2cWrite8(ADDR_BME680, 0x64, bmeGasWait(BME_HEATER_MS));                   // gas_wait_0
  ok &= i2cWrite8(ADDR_BME680, 0x71, 0x10);                     // run_gas=1, heater profile 0
  ok &= i2cWrite8(ADDR_BME680, 0x72, 0x01);                     // humidity oversampling x1
  ok &= i2cWrite8(ADDR_BME680, 0x75, 0x00);                     // IIR filter off
  ok &= i2cWrite8(ADDR_BME680, 0x74, (0x02 << 5) | (0x05 << 2) | 0x01); // T x2, P x16, forced mode
  if (!ok) return r;

  uint8_t d[15];
  uint32_t start = millis();
  do {
    delay(10);
    if (!i2cRead(ADDR_BME680, 0x1D, d, 15)) return r;
    if (millis() - start > 1000) return r;                      // timeout
  } while ((d[0] & 0x80) == 0);                                 // new_data_0

  uint32_t adcP = ((uint32_t)d[2] << 12) | ((uint32_t)d[3] << 4) | (d[4] >> 4);
  uint32_t adcT = ((uint32_t)d[5] << 12) | ((uint32_t)d[6] << 4) | (d[7] >> 4);
  uint16_t adcH = ((uint16_t)d[8] << 8) | d[9];
  uint16_t adcG = ((uint16_t)d[13] << 2) | (d[14] >> 6);
  uint8_t range = d[14] & 0x0F;

  if (adcT == 0x80000 || adcP == 0x80000 || adcH == 0x8000) return r;  // reset values: not measured

  r.done        = true;
  r.temperature = bmeTemperature(adcT);
  r.pressure    = bmePressure(adcP) / 100.0f;
  r.humidity    = bmeHumidity(adcH);
  r.gasValid    = (d[14] & 0x20) != 0;
  r.heatStable  = (d[14] & 0x10) != 0;
  r.gas         = bmeGas(adcG, range);
  return r;
}

void testBME680() {
  heading(3, F("BME680 - temperature / humidity / pressure / gas"));
  if (!hasBME680) { Serial.println(F("    skipped (device not found)")); return; }

  i2cWrite8(ADDR_BME680, 0xE0, 0xB6);   // soft reset
  delay(10);

  uint8_t id = 0;
  bool idOk = i2cRead8(ADDR_BME680, 0xD0, id) && id == 0x61;
  label(F("chip ID (expect 0x61)"));
  if (!result(idOk, printHex8(id), F("wrong chip fitted at U1, or I2C communication error"))) return;

  bool calOk = bmeReadCalibration();
  label(F("calibration data"));
  if (!result(calOk, Serial.print(calOk ? F("valid") : F("invalid")),
              F("calibration memory unreadable: replace U1"))) return;

  BmeReading r;
  float ambient = 25.0;
  bool allDone = true;
  for (uint8_t i = 0; i < BME_CYCLES; i++) {
    r = bmeMeasure(ambient);
    allDone &= r.done;
    if (!r.done) break;
    ambient = r.temperature;
  }
  label(F("measurement cycle"));
  if (!result(allDone, Serial.print(allDone ? F("completed") : F("timeout/error")),
              F("BME680 does not complete measurements: check U1 soldering and 3.3V supply"))) return;

  label(F("temperature"));
  result(r.temperature >= BME_T_MIN && r.temperature <= BME_T_MAX,
         Serial.print(r.temperature, 1) + Serial.print(F(" C")),
         F("temperature out of range (expect room temperature)"));

  label(F("relative humidity"));
  result(r.humidity >= BME_H_MIN && r.humidity <= BME_H_MAX,
         Serial.print(r.humidity, 1) + Serial.print(F(" %")),
         F("humidity out of range: sensor opening blocked/contaminated?"));

  label(F("air pressure"));
  result(r.pressure >= BME_P_MIN && r.pressure <= BME_P_MAX,
         Serial.print(r.pressure, 1) + Serial.print(F(" hPa")),
         F("pressure out of range: sensor damaged?"));

  label(F("gas heater"));
  result(r.heatStable, Serial.print(r.heatStable ? F("stable") : F("not stable")),
         F("gas sensor heater does not reach temperature: replace U1 / check 3.3V supply"));

  bool gasOk = r.gasValid && r.gas >= BME_GAS_MIN && r.gas <= BME_GAS_MAX;
  label(F("gas resistance"));
  uint8_t n;
  if (r.gasValid) n = Serial.print(r.gas / 1000.0, 1) + Serial.print(F(" kOhm"));
  else            n = Serial.print(F("invalid"));
  result(gasOk, n, F("gas reading invalid or out of range"));
}

/* ══════════════════════════════════════════════════════════════════════════
 *  4. VEML6030 - ambient light
 * ══════════════════════════════════════════════════════════════════════════ */
// ALS gain 1/4 (0b11), integration time 100 ms (0b0000), powered on (ALS_SD=0)
const uint16_t VEML_CONF      = (0b11 << 11) | (0b0000 << 6);
const float    VEML_LUX_COUNT = 0.2688;   // lux per count at gain 1/4, 100 ms (Vishay app note 84367)

void testVEML6030() {
  heading(4, F("VEML6030 - ambient light"));
  if (!hasVEML6030) { Serial.println(F("    skipped (device not found)")); return; }

  uint16_t id = 0;
  bool idOk = i2cRead16LE(ADDR_VEML6030, 0x07, id) && (id & 0xFF) == 0x81;
  label(F("device ID (expect 0x81)"));
  if (!result(idOk, printHex8(id & 0xFF), F("wrong chip fitted at U2, or I2C communication error"))) return;

  uint16_t readback = 0;
  bool cfgOk = i2cWrite16LE(ADDR_VEML6030, 0x00, VEML_CONF) &&
               i2cWrite16LE(ADDR_VEML6030, 0x03, 0x0000) &&     // power saving off
               i2cRead16LE(ADDR_VEML6030, 0x00, readback) && readback == VEML_CONF;
  label(F("register write/read-back"));
  if (!result(cfgOk, printHex16(readback), F("configuration register does not hold its value"))) return;

  delay(250);                                                   // > 2 integration periods
  uint16_t als = 0, white = 0;
  bool readOk = i2cRead16LE(ADDR_VEML6030, 0x04, als) && i2cRead16LE(ADDR_VEML6030, 0x05, white);
  label(F("light data readout"));
  if (!result(readOk, Serial.print(readOk ? F("ok") : F("error")), F("I2C communication error"))) return;

  float lux = als * VEML_LUX_COUNT;
  bool saturated = (als == 0xFFFF);
  label(F("ambient light"));
  const __FlashStringHelper *hint = saturated
      ? F("sensor saturated: test away from strong lamps / direct sunlight")
      : F("too dark: test under normal room lighting, do not cover the sensor");
  result(lux >= LUX_MIN && !saturated, Serial.print(lux, 1) + Serial.print(F(" lux")), hint);

  label(F("white channel"));
  result(white > 0, Serial.print(white) + Serial.print(F(" counts")),
         F("white channel reads zero under room light"));
}

/* ══════════════════════════════════════════════════════════════════════════
 *  5. AS7331 - UVA / UVB / UVC
 * ══════════════════════════════════════════════════════════════════════════ */
const uint8_t AS_OSR   = 0x00;
const uint8_t AS_AGEN  = 0x02;
const uint8_t AS_CREG1 = 0x06;
const uint8_t AS_CREG2 = 0x07;
const uint8_t AS_CREG3 = 0x08;
const uint8_t AS_TEMP  = 0x01;   // measurement state
const uint8_t AS_MRES1 = 0x02;   // measurement state

const uint8_t AS_GAIN_CODE = 7;  // gain 2^(11-7) = 16x
const uint8_t AS_TIME_CODE = 7;  // conversion time 2^7 = 128 ms
const float   AS_FSR[3]    = { 348160.0, 387072.0, 169984.0 };  // UVA, UVB, UVC full-scale (µW/cm²)

void testAS7331() {
  heading(5, F("AS7331 - UVA / UVB / UVC"));
  if (!hasAS7331) { Serial.println(F("    skipped (device not found)")); return; }

  // Configuration state, power-down off
  bool ok = i2cWrite8(ADDR_AS7331, AS_OSR, 0x02);
  delay(2);

  uint8_t agen = 0;
  bool idOk = ok && i2cRead8(ADDR_AS7331, AS_AGEN, agen) && (agen >> 4) == 0x2;
  label(F("device ID (expect 0x2x)"));
  if (!result(idOk, printHex8(agen), F("wrong chip fitted at U4, or I2C communication error"))) return;

  const uint8_t creg1 = (AS_GAIN_CODE << 4) | AS_TIME_CODE;
  uint8_t readback = 0;
  bool cfgOk = i2cWrite8(ADDR_AS7331, AS_CREG1, creg1) &&
               i2cWrite8(ADDR_AS7331, AS_CREG2, 0x40) &&        // temperature measurement enabled
               i2cWrite8(ADDR_AS7331, AS_CREG3, 0x40) &&        // command (one-shot) mode, 1.024 MHz
               i2cRead8(ADDR_AS7331, AS_CREG1, readback) && readback == creg1;
  label(F("register write/read-back"));
  if (!result(cfgOk, printHex8(readback), F("configuration register does not hold its value"))) return;

  // Measurement state + start conversion
  bool convOk = i2cWrite8(ADDR_AS7331, AS_OSR, 0x83);
  delay((1 << AS_TIME_CODE) + 50);

  uint8_t osrStatus[2] = { 0, 0 };
  uint8_t mres[6]      = { 0 };
  uint16_t tempRaw     = 0;
  convOk = convOk &&
           i2cRead(ADDR_AS7331, AS_OSR, osrStatus, 2) &&
           i2cRead16LE(ADDR_AS7331, AS_TEMP, tempRaw) &&
           i2cRead(ADDR_AS7331, AS_MRES1, mres, 6);
  label(F("conversion readout"));
  if (!result(convOk, Serial.print(convOk ? F("ok") : F("error")), F("I2C communication error"))) return;

  // STATUS (high byte): bit 6 MRESOF = result overflow, bit 5 ADCOF = ADC overflow
  bool overflow = (osrStatus[1] & 0x60) != 0;
  label(F("ADC overflow"));
  result(!overflow, Serial.print(overflow ? F("YES") : F("no")),
         F("UV channels overflow under room light: test away from UV/strong light, else replace U4"));

  float chipTemp = (tempRaw & 0x0FFF) * 0.05 - 66.9;
  label(F("chip temperature"));
  result(chipTemp >= AS_T_MIN && chipTemp <= AS_T_MAX,
         Serial.print(chipTemp, 1) + Serial.print(F(" C")),
         F("conversion did not complete or temperature sensor faulty"));

  // UV levels are reported for information only: indoor light contains (almost) no UV
  const float scale = (float)(1UL << (11 - AS_GAIN_CODE)) * (float)(1UL << AS_TIME_CODE) * 1024.0;
  for (uint8_t i = 0; i < 3; i++) {
    uint16_t raw = (uint16_t)mres[2 * i] | ((uint16_t)mres[2 * i + 1] << 8);
    if (i == 0)      label(F("UVA (info only)"));
    else if (i == 1) label(F("UVB (info only)"));
    else             label(F("UVC (info only)"));
    Serial.print(raw * AS_FSR[i] / scale, 2);
    Serial.print(F(" uW/cm2  ("));
    Serial.print(raw);
    Serial.print(F(" counts)"));
    info();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 *  Test sequence
 * ══════════════════════════════════════════════════════════════════════════ */
bool passed = false;

void runTest() {
  checksRun = 0;
  checksFailed = 0;
  checksWarned = 0;
  digitalWrite(LED_BUILTIN, LOW);

  Serial.println();
  line('=');
  Serial.println(F("  Freya Terra Sensor - PCB functional test  v" TEST_VERSION));
  line('=');

  if (testBusLines()) {
    Wire.begin();
    Wire.setClock(100000);
#if defined(WIRE_HAS_TIMEOUT) || defined(ARDUINO_ARCH_AVR)
    Wire.setWireTimeout(25000, true);   // never hang on a faulty bus (AVR core >= 1.8.3)
#endif
    testScan();
    testBME680();
    testVEML6030();
    testAS7331();
  } else {
    Serial.println();
    Serial.println(F("    I2C bus not usable - remaining tests skipped."));
    hasBME680 = hasVEML6030 = hasAS7331 = false;
  }

  // A sensor that was not found counts as failed even if its section was skipped
  passed = (checksFailed == 0) && hasBME680 && hasVEML6030 && hasAS7331;

  Serial.println();
  line('#');
  Serial.println(F("##"));
  Serial.print(passed ? F("##        RESULT:   P A S S") : F("##        RESULT:   F A I L"));
  Serial.print(F("      ("));
  Serial.print(checksRun - checksFailed);
  Serial.print('/');
  Serial.print(checksRun);
  Serial.println(F(" checks passed)"));
  if (checksWarned) {
    Serial.print(F("##        "));
    Serial.print(checksWarned);
    Serial.println(F(" warning(s): test conditions not ideal, see WARN above"));
  }
  Serial.println(F("##"));
  line('#');
  Serial.println();
  Serial.println(F("Next board: unplug USB, replace the board, plug USB back in."));
  Serial.println(F("Repeat this board: press RESET or send any character."));
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(SERIAL_BAUD);
  delay(500);                 // let the board power up and the serial monitor attach
  runTest();
}

void loop() {
  // Result on the LED: steady = PASS, fast blink = FAIL
  if (passed) digitalWrite(LED_BUILTIN, HIGH);
  else        digitalWrite(LED_BUILTIN, (millis() / 125) & 1);

  if (Serial.available()) {
    delay(50);
    while (Serial.available()) Serial.read();
    runTest();
  }
}
