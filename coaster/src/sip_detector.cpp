#include "sip_detector.h"

#include <HX711.h>
#include <Preferences.h>

#include "config.h"

namespace sip {
namespace {

HX711 scale;
Preferences prefs;

float factor = SCALE_CALIBRATION;

float samples[SETTLE_SAMPLES];
uint8_t sampleCount = 0;
uint8_t sampleIndex = 0;

float baseline = 0;       // the weight the next change is measured against
float lastSettled = 0;    // most recent weight that held still
float lastReading = 0;
bool haveBaseline = false;

// A reminder began with nothing on the coaster: ignore everything until a
// cup (at least CUP_PRESENT_G) is set down, then use it as the baseline.
bool waitingForCup = false;

// A new level that has settled but not yet held for SETTLE_HOLD_MS.
float candidate = 0;
unsigned long candidateSince = 0;   // 0 = no candidate

// Set by the `sip` serial command, returned by the next poll(). Kept separate
// from the sample buffer so a real reading cannot overwrite it, and so it
// still works with no load cell attached.
Event pendingTest;

/**
 * True when the window is full and its scatter is no more than the sensor's
 * own noise. A min/max spread would be useless here: with ~5 g of noise per
 * reading, 16 readings at rest routinely span 15 g. Lifting or setting down
 * the cup moves readings by tens to hundreds of grams, far above SETTLE_MAX_SD.
 */
bool settled(float& valueOut) {
  if (sampleCount < SETTLE_SAMPLES) return false;
  float sum = 0;
  for (uint8_t i = 0; i < SETTLE_SAMPLES; i++) sum += samples[i];
  const float mean = sum / SETTLE_SAMPLES;
  float sq = 0;
  for (uint8_t i = 0; i < SETTLE_SAMPLES; i++) sq += (samples[i] - mean) * (samples[i] - mean);
  if (sqrtf(sq / SETTLE_SAMPLES) > SETTLE_MAX_SD) return false;
  valueOut = mean;
  return true;
}

void push(float grams) {
  samples[sampleIndex] = grams;
  sampleIndex = (sampleIndex + 1) % SETTLE_SAMPLES;
  if (sampleCount < SETTLE_SAMPLES) sampleCount++;
}

}  // namespace

void begin() {
  scale.begin(PIN_HX711_DT, PIN_HX711_SCK);

  // A factor saved by `cal` wins over the compiled-in default, so calibration
  // survives a reflash and does not have to be copied back into config.h.
  prefs.begin("hydrolet", false);
  factor = prefs.getFloat("scale", SCALE_CALIBRATION);
  scale.set_scale(factor);

  // The empty-coaster zero is saved by `tare`, like the calibration. Taring
  // at boot instead would zero against whatever is sitting there: after a
  // power cut with her cup on the coaster, the cup would read as nothing and
  // every sip would be ignored. Only a coaster that was never tared falls back
  // to taring now.
  if (prefs.isKey("offset")) {
    scale.set_offset(prefs.getLong("offset"));
  } else {
    scale.tare();
  }
  Serial.printf("[SIP] scale ready, %.2f counts/g%s%s\n", factor,
                prefs.isKey("scale") ? " (calibrated)" : " (UNCALIBRATED — run cal)",
                prefs.isKey("offset") ? ", saved zero" : ", zeroed at boot (run tare when empty)");
}

Event poll() {
  Event out;

  if (pendingTest.type != Change::None) {
    out = pendingTest;
    pendingTest = Event{};
    baseline = out.weightG;
    lastSettled = out.weightG;
    haveBaseline = true;
    return out;
  }

  if (!scale.is_ready()) return out;

  lastReading = scale.get_units(1);
  push(lastReading);

  float value;
  if (!settled(value)) {
    candidateSince = 0;   // moving again, so any hold starts over
    return out;
  }

  if (!haveBaseline) {
    baseline = value;
    lastSettled = value;
    haveBaseline = true;
    return out;
  }

  // Still sitting where it was.
  if (fabsf(value - lastSettled) < SETTLE_TOLERANCE) {
    candidateSince = 0;
    return out;
  }

  // A new level. It has to hold still for SETTLE_HOLD_MS before it counts,
  // so the reading is taken after the cells stop creeping, not during it.
  // While it is still creeping the candidate keeps moving and the clock restarts.
  if (candidateSince == 0 || fabsf(value - candidate) >= SETTLE_TOLERANCE) {
    candidate = value;
    candidateSince = millis();
    if (candidateSince == 0) candidateSince = 1;
    return out;
  }
  if (millis() - candidateSince < SETTLE_HOLD_MS) return out;
  candidateSince = 0;

  // The reminder started on an empty coaster. Nothing counts until a cup is
  // set down; that cup's weight is the baseline, not a refill.
  if (waitingForCup) {
    lastSettled = value;
    if (value >= CUP_PRESENT_G) {
      baseline = value;
      waitingForCup = false;
      Serial.printf("[SIP] cup set down, baseline %.1f g\n", baseline);
    }
    return out;
  }

  // Nothing on the coaster: the cup has been picked up, probably to drink.
  // That is not a sip of the whole cup. Leave the baseline alone and judge
  // the change when the cup comes back down.
  if (value < CUP_PRESENT_G) {
    lastSettled = value;
    return out;
  }

  lastSettled = value;
  const float delta = baseline - value;   // positive means lighter, so drunk

  if (fabsf(delta) < MIN_SIP_G) {         // drift, not a real change
    baseline = value;
    return out;
  }

  out.weightG = value;
  if (delta > 0) {
    out.type = Change::Sip;
    out.amountMl = delta * ML_PER_GRAM;
  } else {
    // Heavier: she refilled, or set a cup down. Nothing was drunk.
    out.type = Change::Refill;
  }
  // Either way the new weight is what the next change is measured against.
  baseline = value;
  return out;
}

void resetBaseline() {
  haveBaseline = true;
  if (lastSettled >= CUP_PRESENT_G) {
    // Something past the threshold is on the coaster: that is the cup.
    baseline = lastSettled;
    waitingForCup = false;
    Serial.printf("[SIP] cup on the coaster, baseline %.1f g\n", baseline);
  } else {
    waitingForCup = true;
    Serial.println(F("[SIP] coaster empty: waiting for a cup before counting"));
  }
}

void tareScale() {
  scale.tare(20);
  prefs.putLong("offset", scale.get_offset());
  sampleCount = 0;
  sampleIndex = 0;
  lastSettled = 0;
  baseline = 0;
  haveBaseline = false;
  waitingForCup = false;
  candidateSince = 0;
  Serial.println(F("[SIP] tared (zero saved)"));
}

bool calibrate(float knownGrams) {
  if (knownGrams <= 0) return false;

  // With the factor at 1, a reading is raw counts above the tare point.
  scale.set_scale(1.0f);
  const float counts = scale.get_units(20);
  if (fabsf(counts) < 1000) {           // nothing meaningful on the platform
    scale.set_scale(factor);
    return false;
  }

  factor = counts / knownGrams;
  scale.set_scale(factor);
  prefs.putFloat("scale", factor);

  // Readings taken at the old factor are meaningless now.
  sampleCount = 0;
  sampleIndex = 0;
  haveBaseline = false;

  Serial.printf("[SIP] calibrated: %.2f counts/g (saved)\n", factor);
  return true;
}

float calibrationFactor() { return factor; }

bool cupPresent() { return lastSettled > CUP_PRESENT_G; }
float lastWeightG() { return lastReading; }
float baselineG() { return baseline; }

void injectForTesting(float deltaG) {
  pendingTest.type = deltaG > 0 ? Change::Sip : Change::Refill;
  pendingTest.amountMl = fabsf(deltaG) * ML_PER_GRAM;
  pendingTest.weightG = baseline - deltaG;
}

}  // namespace sip
