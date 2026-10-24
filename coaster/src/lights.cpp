#include "lights.h"

#include <Adafruit_NeoPixel.h>

#include "config.h"

namespace lights {
namespace {

Adafruit_NeoPixel strip(LED_COUNT, PIN_LED_DATA, NEO_GRB + NEO_KHZ800);

float currentFraction = 0.0f;
bool ringOn = false;

unsigned long blinkUntil = 0;

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
  strip.clear();
  strip.show();
}

void showProgress(float fraction) {
  ringOn = true;
  currentFraction = constrain(fraction, 0.0f, 1.0f);
  if (millis() < blinkUntil) return;  // let the blink finish first
  paint(currentFraction);
}

void blinkSip() {
  if (!ringOn) return;
  blinkUntil = millis() + 150;
  fill(255, 255, 255);
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

void tick() {
  if (blinkUntil && millis() >= blinkUntil) {
    blinkUntil = 0;
    if (ringOn) paint(currentFraction);
    else off();
  }
}

}  // namespace lights
