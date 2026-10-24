// BLE link to the watch. The coaster is the central: it scans for the watch,
// connects, and writes commands. UUIDs and command values live in
// shared/ble_protocol.h so the two firmwares cannot disagree.
#pragma once

#include <Arduino.h>

namespace watch {

void begin();

/** Call every loop: reconnects after the watch goes out of range. */
void tick();

bool connected();

/** Light on, start the three buzzes. */
void remind();

/** Stop buzzing — she has started drinking. Light stays on. */
void quiet();

/** Target reached: light off. */
void clear();

void test();

/** True once since the last call: the watch reported an ignored reminder. */
bool takeIgnoredFlag();

}  // namespace watch
