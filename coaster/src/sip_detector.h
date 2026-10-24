// Turns a jittery load-cell signal into "she drank 140 mL".
//
// The four half-bridge cells are wired as one Wheatstone bridge into a single
// HX711, so this reads one combined weight for whatever is sitting on the
// coaster. Readings only count once they have held still: lifting the cup,
// setting it down and the wobble afterwards all have to settle first.
#pragma once

#include <Arduino.h>

namespace sip {

enum class Change {
  None,
  Sip,      // settled lower than the baseline: she drank
  Refill,   // settled higher: topped up, or a cup was put down
};

struct Event {
  Change type = Change::None;
  float amountMl = 0;   // Sip only
  float weightG = 0;    // the new settled weight, which becomes the baseline
};

void begin();

/** Call every loop. Returns Change::None until a new settled weight appears. */
Event poll();

/** Take the current settled weight as the baseline. Start of a reminder. */
void resetBaseline();

/** Zero the scale. Nothing may be on the coaster. */
void tareScale();

/**
 * Works out counts-per-gram from a known weight sitting on the coaster, and
 * saves it so it survives a reboot and a reflash. Returns false if the
 * coaster reads as empty, which means the weight is not on it.
 */
bool calibrate(float knownGrams);

float calibrationFactor();

bool cupPresent();
float lastWeightG();
float baselineG();

/** Feeds a fake settled weight in, for the `sip` serial command. */
void injectForTesting(float deltaG);

}  // namespace sip
