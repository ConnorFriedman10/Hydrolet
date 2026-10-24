#include "watch_link.h"

#include <NimBLEDevice.h>

#include "ble_protocol.h"
#include "config.h"

namespace watch {
namespace {

NimBLEClient* client = nullptr;
NimBLERemoteCharacteristic* commandChar = nullptr;
NimBLERemoteCharacteristic* eventsChar = nullptr;

volatile bool ignoredFlag = false;
unsigned long nextScanAt = 0;

void onEvent(NimBLERemoteCharacteristic*, uint8_t* data, size_t len, bool) {
  if (len < 1) return;
  if (data[0] == EVT_IGNORED) {
    ignoredFlag = true;
    Serial.println(F("[BLE] watch reported ignored"));
  }
}

bool write(uint8_t command) {
  if (!commandChar) return false;
  if (!commandChar->writeValue(&command, 1, false)) {
    Serial.printf("[BLE] write %u failed\n", command);
    return false;
  }
  return true;
}

void connectToWatch() {
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);

  // Duration is milliseconds in NimBLE 2.x (it was seconds in 1.x). This call
  // blocks for its whole duration, so keep it short: until the watch firmware
  // exists there is nothing to find, and every scan is dead time in which
  // serial commands go unread.
  NimBLEScanResults found = scan->getResults(SCAN_DURATION_MS, false);

  for (int i = 0; i < found.getCount(); i++) {
    const NimBLEAdvertisedDevice* dev = found.getDevice(i);
    if (!dev->isAdvertisingService(NimBLEUUID(HYDROLET_SERVICE_UUID))) continue;

    Serial.printf("[BLE] found watch at %s\n", dev->getAddress().toString().c_str());
    if (!client) client = NimBLEDevice::createClient();

    if (!client->connect(dev)) {
      Serial.println(F("[BLE] connect failed"));
      scan->clearResults();
      return;
    }

    NimBLERemoteService* service = client->getService(HYDROLET_SERVICE_UUID);
    if (!service) {
      Serial.println(F("[BLE] service missing"));
      client->disconnect();
      scan->clearResults();
      return;
    }

    commandChar = service->getCharacteristic(HYDROLET_CHAR_COMMAND);
    eventsChar = service->getCharacteristic(HYDROLET_CHAR_EVENTS);
    if (eventsChar && eventsChar->canNotify()) eventsChar->subscribe(true, onEvent);

    Serial.println(F("[BLE] watch connected"));
    scan->clearResults();
    return;
  }
  scan->clearResults();
}

}  // namespace

void begin() {
  NimBLEDevice::init("hydrolet-coaster");
  NimBLEDevice::setPower(9);   // dBm in NimBLE 2.x
}

void tick() {
  if (connected()) return;
  if (millis() < nextScanAt) return;
  nextScanAt = millis() + SCAN_INTERVAL_MS;   // Wi-Fi shares this radio
  commandChar = nullptr;
  eventsChar = nullptr;
  connectToWatch();
}

bool connected() { return client && client->isConnected(); }

void remind() { write(CMD_REMIND); }
void quiet()  { write(CMD_QUIET); }
void clear()  { write(CMD_CLEAR); }
void test()   { write(CMD_TEST); }

bool takeIgnoredFlag() {
  const bool was = ignoredFlag;
  ignoredFlag = false;
  return was;
}

}  // namespace watch
