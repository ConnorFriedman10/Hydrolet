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
    // The band sends this as soon as its own short buzz pattern ends, about a
    // second into the reminder — far too early to mean "no sip". The coaster
    // is the source of truth for hydration and runs the ignored timeout
    // itself (three buzzes a minute apart, then IGNORED_TIMEOUT_MS), so the
    // event is logged and otherwise left alone. Acting on it ended every
    // reminder as "ignored" before anyone could drink.
    Serial.println(F("[BLE] watch finished its buzz pattern"));
  } else if (data[0] == EVT_BUTTON_PRESS) {
    Serial.println(F("[BLE] watch button pressed"));
  }
}

bool write(uint8_t command) {
  if (!commandChar) {
    Serial.printf("[BLE] watch not connected, command %u not sent\n", command);
    return false;
  }
  Serial.printf("[BLE] -> watch command %u\n", command);
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

    if (!commandChar) {
      Serial.println(F("[BLE] watch has no command characteristic; check shared/ble_protocol.h"));
    }
    Serial.println(F("[BLE] watch connected"));
    scan->clearResults();
    return;
  }
  scan->clearResults();
}

}  // namespace

void scanReport(unsigned long ms) {
  if (connected()) {
    Serial.printf("[BLE] already connected to the watch at %s\n",
                  client->getPeerAddress().toString().c_str());
    return;
  }
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  NimBLEScanResults found = scan->getResults(ms, false);
  Serial.printf("[BLE] scan %lu ms: %d devices\n", ms, found.getCount());
  for (int i = 0; i < found.getCount(); i++) {
    const NimBLEAdvertisedDevice* dev = found.getDevice(i);
    const bool hydrolet = dev->isAdvertisingService(NimBLEUUID(HYDROLET_SERVICE_UUID));
    const std::string name = dev->getName();
    // Unnamed devices without the service are just noise (phones, laptops).
    if (!hydrolet && name.empty()) continue;
    Serial.printf("[BLE]   %s %4d dBm  %-20s%s\n", dev->getAddress().toString().c_str(),
                  dev->getRSSI(), name.c_str(), hydrolet ? "  <- Hydrolet service" : "");
  }
  scan->clearResults();
}

void begin() {
  NimBLEDevice::init("hydrolet-coaster");
  NimBLEDevice::setPower(9);   // dBm in NimBLE 2.x
}

void tick(bool allowed) {
  // Wi-Fi first. Wi-Fi and BLE share one radio, and while the watch link was
  // up the NUwave (WPA2-Enterprise) login never completed. Without Wi-Fi the
  // coaster has no clock and no schedule, so the watch has nothing to do anyway.
  if (!allowed) {
    if (connected()) {
      Serial.println(F("[BLE] wifi down: pausing the watch link until it is back"));
      client->disconnect();
    }
    commandChar = nullptr;
    eventsChar = nullptr;
    return;
  }
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
