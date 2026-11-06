# Testing the Freya Terra Sensor boards

**Materials**
- Arduino Uno (or equivalent)
- Crowtail Base Shield for Arduino 2.0
- USB cable (for serial connection between Arduino and computer)
- 4 Pin Crowtail Cable (connecting sensor to Arduino)
- A host computer with an Arduino programming environment and serial console.

**Preparation:**
1) Fit the Crowtail Base Shield on the Arduino board
2) Plug a 4 Pin Crowtail cable in an I2C socket
3) Connect the Arduino to the computer through USB, and upload the testing program ([`TerraSensorTest`](TerraSensorTest/TerraSensorTest.ino), serial console at 9600 baud)
4) Disconnect the USB connection from the host to power off the Arduino.

**Testing procedure**
1) Connect the Terra sensor board to the I2C socket of the Arduino fitted with the Crowtail Base Shield using the 4 Pin Crowtail cable.
2) Connect the Arduino with the host, providing it with power and the serial connection
3) The test runs automatically and ends with **RESULT: PASS** or **RESULT: FAIL** on the serial console. Failed checks are marked `FAIL <<<` with a hint about the cause.
4) Disconnect the USB connection and the sensor board, and repeat for the next board.

> [!NOTE]
> Test under normal room lighting, and don't cover the sensors: the light sensor must see some light to pass.
