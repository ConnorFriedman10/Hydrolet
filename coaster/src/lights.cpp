#include "lights.h"

#include <Adafruit_NeoPixel.h>

#include "config.h"

namespace lights {
namespace {

Adafruit_NeoPixel strip(LED_COUNT, PIN_LED_DATA, NEO_GRB + NEO_KHZ800);

float currentFraction = 0.0f;
bool ringOn = false;

unsigned long blinkUntil = 0;

// Finish animation: counts down on/off steps, one every DONE_FLASH_MS.
uint8_t celebrateSteps = 0;
unsigned long nextCelebrateStep = 0;

void fill(uint8_t r, uint8_t g, uint8_t b) {
  for (uint16_t i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, strip.Color(r, g, b));
  strip.show();
}

/**
 * Green through amber to red. Interpolating red and green directly dips dark
 * in the middle, because both channels are half off at once, so the midpoint
 * is lifted to a proper amber.
 */
void paint(float f) {
  f = constrain(f, 0.0f, 1.0f);
  uint8_t r, g;
  if (f < 0.5f) {           // green -> amber
    r = (uint8_t)(255.0f * (f / 0.5f));
    g = 255;
  } else {                  // amber -> red
    r = 255;
    g = (uint8_t)(255.0f * (1.0f - (f - 0.5f) / 0.5f));
  }
  fill(r, g, 0);
}

}  // namespace

void begin() {
  strip.begin();
  strip.setBrightness(LED_BRIGHTNESS);
  strip.clear();
  strip.show();
}

void off() {
  ringOn = false;
  blinkUntil = 0;
  celebrateSteps = 0;
  strip.clear();
  strip.show();
}

void showProgress(float fraction) {
  ringOn = true;
  celebrateSteps = 0;
  currentFraction = constrain(fraction, 0.0f, 1.0f);
  if (millis() < blinkUntil) return;  // let the blink finish first
  paint(currentFraction);
}

void blinkSip() {
  if (!ringOn) return;
  // A brief dark dip rather than a white flash: just as visible, and white
  // on every pixel would draw far more current than the ring otherwise does.
  blinkUntil = millis() + 150;
  strip.clear();
  strip.show();
}

void celebrate() {
  // Full red, then DONE_FLASHES rounds of off/on, then off for good. Even
  // steps are "off", odd steps are "on"; the last step leaves it dark.
  blinkUntil = 0;
  ringOn = false;
  paint(1.0f);
  celebrateSteps = DONE_FLASHES * 2;
  nextCelebrateStep = millis() + DONE_FLASH_MS * 2;   // hold the full red a moment first
}

void selfTest() {
  const uint32_t colours[] = {strip.Color(255, 0, 0), strip.Color(0, 255, 0), strip.Color(0, 0, 255)};
  for (uint32_t c : colours) {
    for (uint16_t i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, c);
    strip.show();
    delay(250);
  }
  off();
}

void countTest(uint16_t upTo, unsigned long holdMs) {
  // Drive far more pixels than configured, dim so even a long strip stays
  // well under the supply's limit: every 10th pixel red, the rest blue. Count
  // the red ones to read off how many pixels the ring really has.
  strip.updateLength(upTo);
  strip.setBrightness(255);
  for (uint16_t i = 0; i < upTo; i++) {
    strip.setPixelColor(i, (i % 10 == 9) ? strip.Color(40, 0, 0) : strip.Color(0, 0, 8));
  }
  strip.show();
  delay(holdMs);
  strip.clear();
  strip.show();
  strip.updateLength(LED_COUNT);
  strip.setBrightness(LED_BRIGHTNESS);
  ringOn = false;
}

void tick() {
  if (celebrateSteps && millis() >= nextCelebrateStep) {
    celebrateSteps--;
    nextCelebrateStep = millis() + DONE_FLASH_MS;
    if (celebrateSteps % 2 == 1) {
      strip.clear();
      strip.show();
    } else if (celebrateSteps > 0) {
      paint(1.0f);
    } else {
      strip.clear();   // done: stays off until the next reminder
      strip.show();
    }
  }

  if (blinkUntil && millis() >= blinkUntil) {
    blinkUntil = 0;
    if (ringOn) paint(currentFraction);
    else off();
  }
}

}  // namespace lights
