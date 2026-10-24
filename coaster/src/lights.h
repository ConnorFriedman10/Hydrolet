// The ring around the coaster. Off between reminders; during one it shows a
// single colour that sweeps green to red as she drinks towards the target.
#pragma once

#include <Arduino.h>

namespace lights {

void begin();

/** Ring off. Between reminders, and once a reminder is finished. */
void off();

/** 0.0 = nothing drunk yet (green) .. 1.0 = target reached (red). */
void showProgress(float fraction);

/** Brief confirmation that a sip registered, then back to the progress colour. */
void blinkSip();

/** Target reached: full red, a few on/off flashes, then off. Non-blocking. */
void celebrate();

/** Startup / `test` serial command. */
void selfTest();

/**
 * Diagnostic: lights `upTo` pixels dimly (every 10th red) for holdMs, so the
 * real number of pixels on the ring can be counted. Blocks while lit.
 */
void countTest(uint16_t upTo, unsigned long holdMs);

/** Call every loop; drives the blink timing without blocking. */
void tick();

}  // namespace lights
