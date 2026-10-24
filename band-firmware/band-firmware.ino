/**
 * Hydrolet Band Firmware — XIAO nRF52840
 *
 * Arduino IDE sketch. Requires:
 *   Board: "Seeed nRF52 Boards" package → Seeed XIAO nRF52840
 *
 * Uses bluefruit.h (Adafruit Bluefruit nRF52, included with board package).
 * Acts as a BLE peripheral. The coaster (ESP32-C3 central) scans for
 * HYDROLET_SERVICE_UUID and connects automatically.
 *
 * Pin mapping (matches schematic):
 *   D10 — motor/buzzer via PN2222A transistor
 *   D2  — external green LED via 330 Ω resistor
 *   LED_BUILTIN — onboard blue LED (active-LOW on XIAO nRF52840)
 */

#include <bluefruit.h>

// ── BLE UUIDs (from shared/ble_protocol.h) ────────────────────────────────────
const char HYDROLET_SERVICE_UUID[] = "3518a23d-30b7-4c54-88a1-eaf73b3cc524";
const char HYDROLET_CHAR_COMMAND[] = "299471a5-cbac-4afb-ad34-2ec6900b0eec";
const char HYDROLET_CHAR_EVENTS[]  = "ec66bf06-7006-4b2f-92f2-1d7ca727b1bf";

// ── Commands (coaster → band) ─────────────────────────────────────────────────
#define CMD_REMIND  1   // green LED on + three buzzes
#define CMD_QUIET   2   // stop buzzing, LED stays on (user sipped)
#define CMD_CLEAR   3   // everything off (daily target reached)
#define CMD_TEST    4   // same as REMIND, for hardware testing

// ── Events (band → coaster, via notify) ──────────────────────────────────────
#define EVT_IGNORED  1  // three buzzes finished, no sip detected

// ── Pin definitions ───────────────────────────────────────────────────────────
const int PIN_MOTOR = D10;
const int PIN_LED   = D2;
// LED_BUILTIN = onboard blue LED, active-LOW

// ── Buzz pattern ──────────────────────────────────────────────────────────────
#define BUZZ_COUNT   3    // number of pulses
#define BUZZ_ON_MS   200  // motor on time per pulse (ms)
#define BUZZ_OFF_MS  200  // gap between pulses (ms)

// ── BLE service and characteristics ───────────────────────────────────────────
BLEService        hydroletService(HYDROLET_SERVICE_UUID);
BLECharacteristic cmdChar(HYDROLET_CHAR_COMMAND);
BLECharacteristic evtChar(HYDROLET_CHAR_EVENTS);

// ── Buzz state machine (non-blocking) ────────────────────────────────────────
bool     buzzing    = false;
uint8_t  buzzStep   = 0;      // even = motor ON, odd = gap; >= BUZZ_COUNT*2 = done
uint32_t buzzLastMs = 0;

// ── Pin helpers ───────────────────────────────────────────────────────────────
void onboardLedOn()  { digitalWrite(LED_BUILTIN, LOW);  }  // active-LOW
void onboardLedOff() { digitalWrite(LED_BUILTIN, HIGH); }
void extLedOn()      { digitalWrite(PIN_LED, HIGH); }
void extLedOff()     { digitalWrite(PIN_LED, LOW);  }
void motorOn()       { digitalWrite(PIN_MOTOR, HIGH); }
void motorOff()      { digitalWrite(PIN_MOTOR, LOW);  }

void startBuzz() {
  buzzing    = true;
  buzzStep   = 0;
  buzzLastMs = millis();
  motorOn();
  onboardLedOn();
}

void stopBuzz() {
  buzzing = false;
  motorOff();
  onboardLedOff();
}

// Call every loop() — drives the buzz state machine without blocking.
void tickBuzz() {
  if (!buzzing) return;

  bool onPhase      = (buzzStep % 2 == 0);
  uint32_t duration = onPhase ? BUZZ_ON_MS : BUZZ_OFF_MS;

  if (millis() - buzzLastMs < duration) return;

  buzzStep++;
  buzzLastMs = millis();

  if (buzzStep >= BUZZ_COUNT * 2) {
    stopBuzz();
    // Notify coaster that the reminder was ignored
    if (Bluefruit.connected() && evtChar.notifyEnabled()) {
      uint8_t evt = EVT_IGNORED;
      evtChar.notify(&evt, 1);
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
void handleCommand(uint8_t cmd) {
  switch (cmd) {
    case CMD_REMIND:
      extLedOn();
      startBuzz();
      break;

    case CMD_QUIET:
      stopBuzz();
      // External LED stays on — user sipped but hasn't hit target yet
      break;

    case CMD_CLEAR:
      stopBuzz();
      extLedOff();
      break;

    case CMD_TEST:
      extLedOn();
      startBuzz();
      break;

    default:
      break;
  }
}

// ── BLE callbacks ─────────────────────────────────────────────────────────────
void connect_callback(uint16_t conn_handle) {
  // Brief onboard LED flash to confirm connection
  onboardLedOn();
  delay(100);
  onboardLedOff();
}

void disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  stopBuzz();
  extLedOff();
  // Bluefruit automatically restarts advertising (restartOnDisconnect=true)
}

void cmd_write_callback(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len == 1) {
    handleCommand(data[0]);
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  pinMode(PIN_MOTOR,   OUTPUT); digitalWrite(PIN_MOTOR,   LOW);
  pinMode(PIN_LED,     OUTPUT); digitalWrite(PIN_LED,     LOW);
  pinMode(LED_BUILTIN, OUTPUT); digitalWrite(LED_BUILTIN, HIGH); // off (active-LOW)

  // BLE init
  Bluefruit.begin();
  Bluefruit.setTxPower(4);  // max +4 dBm
  Bluefruit.setName("Hydrolet-Band");
  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);

  // Configure service
  hydroletService.begin();

  // Command characteristic: coaster writes to this
  cmdChar.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  cmdChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  cmdChar.setWriteCallback(cmd_write_callback);
  cmdChar.begin();

  // Events characteristic: band notifies coaster
  evtChar.setProperties(CHR_PROPS_NOTIFY);
  evtChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  evtChar.begin();

  // Advertising
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(hydroletService);
  Bluefruit.Advertising.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.start(0);  // advertise forever

  Serial.println("Hydrolet Band ready — advertising...");
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  tickBuzz();
}
