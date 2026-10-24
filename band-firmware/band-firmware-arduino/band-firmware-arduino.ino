// =====================================================================
// Hydrolet Band Firmware - XIAO nRF52840 Sense
// =====================================================================
//
// HARDWARE SETUP:
//   Board: Seeed nRF52 Boards -> Seeed XIAO nRF52840 Sense
//   Port:  COM6 (or whatever port your board shows up as)
//
// WIRING:
//   D10 -> 470Ω resistor -> PN2222A transistor base
//   Motor positive -> 3.3V
//   Motor negative -> transistor collector
//   1N4148 flyback diode across motor (cathode to 3.3V)
//   Transistor emitter -> GND
//
//   D2 -> 330Ω resistor -> Green LED anode
//   LED cathode -> GND
//
// HOW IT WORKS:
//   1. On boot: LED blinks 3x + motor buzzes 1x (self-test)
//   2. Advertises as "Hydrolet-Band" with custom Hydrolet service UUID
//   3. Coaster (ESP32-C3) scans and auto-connects when it finds this UUID
//   4. On connection: LED blinks 3x + motor buzzes 1x (connection confirm)
//   5. Coaster writes commands to HYDROLET_CHAR_COMMAND characteristic
//   6. Band responds by controlling LED and motor
//   7. Band can notify coaster via HYDROLET_CHAR_EVENTS characteristic
//
// BLE PROTOCOL (from shared/ble_protocol.h):
//   Service UUID: 3518a23d-30b7-4c54-88a1-eaf73b3cc524
//   
//   Command Characteristic (coaster writes to band):
//     UUID: 299471a5-cbac-4afb-ad34-2ec6900b0eec
//     Commands:
//       0x01 (CMD_REMIND) = Turn on LED + buzz 3x (reminder time)
//       0x02 (CMD_QUIET)  = Stop buzzing (user took a sip)
//       0x03 (CMD_CLEAR)  = Turn off LED (daily target reached)
//       0x04 (CMD_TEST)   = Same as REMIND (for testing)
//
//   Events Characteristic (band notifies coaster):
//     UUID: ec66bf06-7006-4b2f-92f2-1d7ca727b1bf
//     Events:
//       0x01 (EVT_IGNORED) = Sent after 3 buzzes finish with no CMD_QUIET
//
// TESTING WITH NRF CONNECT APP:
//   1. Scan for "Hydrolet-Band"
//   2. Connect (you'll see 3 blinks + 1 buzz)
//   3. Find the Hydrolet service (3518a23d...)
//   4. Write to Command characteristic (299471a5...):
//      - Write 0x01 -> LED on + buzz 3x
//      - Write 0x03 -> LED off
//   5. Enable notifications on Events characteristic (ec66bf06...)
//      - After sending 0x01, you'll receive 0x01 notification
//
// SERIAL MONITOR (115200 baud):
//   Shows connection events and received commands for debugging
//
// =====================================================================

#include <bluefruit.h>

// ── BLE protocol (from shared/ble_protocol.h) ─────────────────────────────────
const char HYDROLET_SERVICE_UUID[] = "3518a23d-30b7-4c54-88a1-eaf73b3cc524";
const char HYDROLET_CHAR_COMMAND[] = "299471a5-cbac-4afb-ad34-2ec6900b0eec";
const char HYDROLET_CHAR_EVENTS[]  = "ec66bf06-7006-4b2f-92f2-1d7ca727b1bf";

#define CMD_REMIND  1
#define CMD_QUIET   2
#define CMD_CLEAR   3
#define CMD_TEST    4
#define EVT_IGNORED 1

// ── Hardware pins ─────────────────────────────────────────────────────────────
const int MOTOR = D10;   // transistor base via 470 ohm
const int LED   = D2;    // status LED via 330 ohm

// ── BLE ───────────────────────────────────────────────────────────────────────
BLEService        hydroletService(HYDROLET_SERVICE_UUID);
BLECharacteristic cmdChar(HYDROLET_CHAR_COMMAND);
BLECharacteristic evtChar(HYDROLET_CHAR_EVENTS);

// ── Helpers ───────────────────────────────────────────────────────────────────
void buzz(int pulses) {
  for (int i = 0; i < pulses; i++) {
    digitalWrite(MOTOR, HIGH); delay(300);
    digitalWrite(MOTOR, LOW);  delay(150);
  }
}

void blinkLED(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED, HIGH); delay(150);
    digitalWrite(LED, LOW);  delay(150);
  }
}

void selfTest() {
  blinkLED(3);   // LED check
  buzz(1);       // motor check
}

// ── BLE callbacks ─────────────────────────────────────────────────────────────
void connect_callback(uint16_t conn_handle) {
  (void)conn_handle;
  Serial.println("[BLE] coaster connected");
  blinkLED(3);   // 3 blinks on connection
  buzz(1);       // 1 buzz on connection
}

void disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  (void)conn_handle;
  (void)reason;
  digitalWrite(LED, LOW);  // turn off LED on disconnect
  Serial.println("[BLE] coaster disconnected");
}

void cmd_write_callback(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  (void)conn_hdl;
  (void)chr;
  
  Serial.printf("[CMD] Received %u bytes: ", len);
  for (uint16_t i = 0; i < len; i++) {
    Serial.printf("0x%02X ", data[i]);
  }
  Serial.println();
  
  if (len != 1) return;
  uint8_t cmd = data[0];
  
  switch (cmd) {
    case CMD_REMIND:
      Serial.println("[CMD] REMIND - LED on + buzz 3x");
      digitalWrite(LED, HIGH);
      buzz(3);
      // Send EVT_IGNORED after buzzes finish
      if (evtChar.notifyEnabled()) {
        uint8_t evt = EVT_IGNORED;
        evtChar.notify(&evt, 1);
        Serial.println("[EVT] Sent EVT_IGNORED");
      }
      break;
      
    case CMD_QUIET:
      Serial.println("[CMD] QUIET");
      break;
      
    case CMD_CLEAR:
      Serial.println("[CMD] CLEAR - LED off");
      digitalWrite(LED, LOW);
      break;
      
    case CMD_TEST:
      Serial.println("[CMD] TEST - LED on + buzz 3x");
      digitalWrite(LED, HIGH);
      buzz(3);
      break;
      
    default:
      Serial.printf("[CMD] unknown: 0x%02X\n", cmd);
      break;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  pinMode(MOTOR, OUTPUT); digitalWrite(MOTOR, LOW);
  pinMode(LED, OUTPUT);   digitalWrite(LED, LOW);
  Serial.begin(115200);
  
  selfTest();                                   // boot: 3 blinks + 1 buzz
  
  Bluefruit.begin();
  Bluefruit.setTxPower(4);                      // max power for range
  Bluefruit.setName("Hydrolet-Band");
  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);
  
  // Configure Hydrolet service
  hydroletService.begin();
  
  cmdChar.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  cmdChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  cmdChar.setWriteCallback(cmd_write_callback);
  cmdChar.begin();
  
  evtChar.setProperties(CHR_PROPS_NOTIFY);
  evtChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  evtChar.begin();
  
  // Advertising
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(hydroletService);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.start(0);               // advertise forever
  
  Serial.println("Hydrolet-Band ready");
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  // LED stays off unless commanded on by CMD_REMIND or CMD_TEST
}
