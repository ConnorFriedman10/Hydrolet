/**
 * Hydrolet Band Firmware — XIAO nRF52840 Sense
 *
 * Acts as a BLE peripheral. The coaster (ESP32-C3 central) scans for
 * HYDROLET_SERVICE_UUID and connects automatically, then writes commands.
 *
 * Pin mapping (matches schematic):
 *   D10 (P0.02) — motor/buzzer via PN2222A transistor
 *   D2  (P0.28) — external green LED via 330 Ω resistor
 *   LED_BUILTIN — onboard blue LED (active-LOW on XIAO nRF52840)
 */

#include <Arduino.h>
#include <bluefruit.h>
#include "ble_protocol.h"

// ── Pin definitions ───────────────────────────────────────────────────────────
static constexpr uint8_t PIN_MOTOR = D10;
static constexpr uint8_t PIN_LED   = D2;
// LED_BUILTIN is defined by the board package (onboard blue LED, active-LOW)

// ── Buzz pattern ─────────────────────────────────────────────────────────────
// CMD_REMIND: three 200 ms pulses, 200 ms apart
static constexpr uint8_t  BUZZ_COUNT    = 3;
static constexpr uint32_t BUZZ_ON_MS    = 200;
static constexpr uint32_t BUZZ_OFF_MS   = 200;

// ── BLE service and characteristics ───────────────────────────────────────────
BLEService        hydroletService(HYDROLET_SERVICE_UUID);
BLECharacteristic cmdChar(HYDROLET_CHAR_COMMAND);
BLECharacteristic evtChar(HYDROLET_CHAR_EVENTS);

// ── Buzz state machine (non-blocking) ────────────────────────────────────────
static bool     buzzing      = false;
static uint8_t  buzzStep     = 0;   // 0,2,4 = ON; 1,3,5 = OFF gap; 6 = done
static uint32_t buzzLastMs   = 0;

// ── Pin helpers ───────────────────────────────────────────────────────────────
static void onboardLedOn()  { digitalWrite(LED_BUILTIN, LOW);  }  // active-LOW
static void onboardLedOff() { digitalWrite(LED_BUILTIN, HIGH); }
static void extLedOn()      { digitalWrite(PIN_LED, HIGH); }
static void extLedOff()     { digitalWrite(PIN_LED, LOW);  }
static void motorOn()       { digitalWrite(PIN_MOTOR, HIGH); }
static void motorOff()      { digitalWrite(PIN_MOTOR, LOW);  }

static void startBuzz() {
    buzzing    = true;
    buzzStep   = 0;
    buzzLastMs = millis();
    motorOn();
    onboardLedOn();
}

static void stopBuzz() {
    buzzing = false;
    motorOff();
    onboardLedOff();
}

// Called every loop(); drives the non-blocking buzz state machine.
static void tickBuzz() {
    if (!buzzing) return;

    uint32_t now = millis();
    bool onPhase = (buzzStep % 2 == 0);          // even step = motor ON
    uint32_t duration = onPhase ? BUZZ_ON_MS : BUZZ_OFF_MS;

    if (now - buzzLastMs < duration) return;     // not time yet

    buzzStep++;
    buzzLastMs = now;

    if (buzzStep >= BUZZ_COUNT * 2) {
        // Finished all pulses
        stopBuzz();
        
        // Flash green LED 3 times to celebrate completion
        for (uint8_t i = 0; i < 3; i++) {
            extLedOn();
            delay(150);
            extLedOff();
            delay(150);
        }
        extLedOn();  // leave it on after flashing

        // Report EVT_IGNORED to coaster if still connected
        if (Bluefruit.connected() && evtChar.notifyEnabled()) {
            uint8_t evt = EVT_IGNORED;
            evtChar.notify(&evt, 1);
            Serial.println(F("[BAND] reported EVT_IGNORED"));
        }
        return;
    }

    if (buzzStep % 2 == 0) {
        motorOn();
        onboardLedOn();
    } else {
        motorOff();
        onboardLedOff();
    }
}

// ── BLE command handler ───────────────────────────────────────────────────────
static void handleCommand(uint8_t cmd) {
    switch (cmd) {
        case CMD_REMIND:
            // Turn on external green LED and start three-buzz pattern
            extLedOn();
            startBuzz();
            Serial.println(F("[BAND] CMD_REMIND"));
            break;

        case CMD_QUIET:
            // Coaster saw a sip; stop buzzing but keep the LED on
            stopBuzz();
            Serial.println(F("[BAND] CMD_QUIET"));
            break;

        case CMD_CLEAR:
            // Target reached; everything off
            stopBuzz();
            extLedOff();
            Serial.println(F("[BAND] CMD_CLEAR"));
            break;

        case CMD_TEST:
            // Single short buzz + LED flash for hardware test
            extLedOn();
            startBuzz();
            Serial.println(F("[BAND] CMD_TEST"));
            break;

        default:
            Serial.printf("[BAND] unknown command: %u\n", cmd);
            break;
    }
}

// ── BLE callbacks ─────────────────────────────────────────────────────────────
void connect_callback(uint16_t conn_handle) {
    (void)conn_handle;
    Serial.println(F("[BLE] coaster connected"));
    // Brief onboard LED flash to confirm connection
    onboardLedOn();
    delay(100);
    onboardLedOff();
}

void disconnect_callback(uint16_t conn_handle, uint8_t reason) {
    (void)conn_handle;
    (void)reason;
    Serial.println(F("[BLE] coaster disconnected"));
    stopBuzz();
    extLedOff();
    // Bluefruit automatically restarts advertising (restartOnDisconnect=true)
}

void cmd_write_callback(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
    (void)conn_hdl;
    (void)chr;
    if (len == 1) {
        handleCommand(data[0]);
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println(F("\n[BOOT] Hydrolet band"));

    // GPIO init
    pinMode(PIN_MOTOR,   OUTPUT); digitalWrite(PIN_MOTOR,   LOW);
    pinMode(PIN_LED,     OUTPUT); digitalWrite(PIN_LED,     LOW);
    pinMode(LED_BUILTIN, OUTPUT); digitalWrite(LED_BUILTIN, HIGH); // off (active-LOW)

    // Brief boot buzz to confirm hardware is working
    digitalWrite(PIN_MOTOR, HIGH);
    delay(200);
    digitalWrite(PIN_MOTOR, LOW);

    // Flash onboard LED 5 times to confirm upload completed
    for (uint8_t i = 0; i < 5; i++) {
        onboardLedOn();
        delay(100);
        onboardLedOff();
        delay(100);
    }

    // BLE init
    Bluefruit.begin();
    Bluefruit.setTxPower(4);  // max +4 dBm
    Bluefruit.setName("Hydrolet-Band");
    Bluefruit.Periph.setConnectCallback(connect_callback);
    Bluefruit.Periph.setDisconnectCallback(disconnect_callback);

    // Configure service
    hydroletService.begin();

    // Command characteristic: coaster writes commands here
    cmdChar.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
    cmdChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
    cmdChar.setWriteCallback(cmd_write_callback);
    cmdChar.begin();

    // Events characteristic: band notifies coaster (e.g. reminder ignored)
    evtChar.setProperties(CHR_PROPS_NOTIFY);
    evtChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
    evtChar.begin();

    // Advertising
    Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
    Bluefruit.Advertising.addService(hydroletService);
    Bluefruit.Advertising.addName();
    Bluefruit.Advertising.restartOnDisconnect(true);
    Bluefruit.Advertising.start(0);  // advertise forever

    Serial.println(F("[BOOT] ready, advertising"));
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
    tickBuzz();
}
