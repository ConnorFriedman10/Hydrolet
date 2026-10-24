// Everything tunable in one place, so nothing has to be hunted for in the
// middle of the event.
#pragma once

// --- Pins (XIAO ESP32-C3 silkscreen labels, see the wiring diagram) --------
#define PIN_HX711_DT   D3
#define PIN_HX711_SCK  D4
#define PIN_LED_DATA   D2

// --- LED ring --------------------------------------------------------------
// At least as many as the ring really has; extra pixels cost nothing (the
// data just runs off the end). 18 lit only a quarter of the ring, and the
// 200-pixel `ledcount` test covered all of it.
#define LED_COUNT      200

// Current scales with the pixels that really exist, not LED_COUNT. With the
// ring around 70+ pixels, amber (the brightest step: red and green both full)
// at 40/255 is roughly 450 mA, which a USB supply can carry alongside the
// ESP32-C3. The old 90 would have been about 1 A and could reset the board.
// Raise it only after measuring the real draw.
#define LED_BRIGHTNESS 40   // of 255

// Target reached: the ring flashes red this many times, then goes off.
#define DONE_FLASHES   4
#define DONE_FLASH_MS  250UL   // each on, and each off

// --- Load cell -------------------------------------------------------------
// Counts per gram. Find it by putting a known weight on the coaster and
// running the `cal` serial command; see README.
#define SCALE_CALIBRATION 420.0f

// Load cells are noisy, so a reading only counts once it has held still.
// Measured on the built coaster after calibration: single readings scatter
// with a standard deviation of about 5 g (four 50 kg cells give only ~14
// counts per gram). So stillness is judged on the scatter of a window, and
// the weight is that window's average, which is good to about ±1.5 g.
//
// Together, SETTLE_SAMPLES and SETTLE_HOLD_MS are how long after the cup is set
// down a sip shows on the ring: at the HX711's 10 readings a second, 10 samples
// is 1 s to fill the window, then 1 s of hold, so about 2 s. (It was 16 and
// 2000 ms, about 3.6 s.) Ten samples still average to about ±1.6 g.
#define SETTLE_SAMPLES   10     // window of readings judged together
#define SETTLE_MAX_SD    8.0f   // grams; above this the cup is moving
#define SETTLE_TOLERANCE 4.0f   // grams; a smaller shift in the average is the same weight
// Smaller changes are noise, not a sip. Keep it above SETTLE_TOLERANCE: a
// change smaller than that never even registers as a new weight.
#define MIN_SIP_G        5.0f
// Load cells creep for a second or two after a cup is set down (measured: a
// reading 8 g low that climbed to its true value). A new weight only counts
// once it has stayed within SETTLE_TOLERANCE for this long. Shorter means a
// faster ring, at the cost of reading a sip a few grams large while the cells
// are still creeping; raise it back towards 2000 if sips come out too big.
#define SETTLE_HOLD_MS   1000UL
// Below this, nothing is on the coaster; at or above it, that is the cup.
// Kept as low as the hardware allows: the empty reading has been seen to
// drift by up to about ±15 g, and even a light plastic cup is 30 g or more.
#define CUP_PRESENT_G    20.0f

// 1 mL of water weighs 1 g. Kept named so the intent is obvious at the call site.
#define ML_PER_GRAM 1.0f

// --- Reminder cycle --------------------------------------------------------
// An on-demand "remind her now" has no scheduled amount behind it, so it
// needs a stand-in target to measure against.
#define REMIND_NOW_ML       150

#define BUZZ_COUNT          3
#define BUZZ_INTERVAL_MS    60000UL   // one minute apart
#define IGNORED_TIMEOUT_MS  120000UL  // after the last buzz, with no sip at all
// A reminder found more than this late (coaster was off, or offline) is
// skipped rather than fired, so a boot at 2pm does not replay the morning.
#define MISSED_GRACE_MIN    30

// --- Watch (BLE) -----------------------------------------------------------
// A scan blocks the loop for its full duration, so it is kept short and
// infrequent. Nothing needs it to be fast: the watch is found within a few
// seconds of coming into range either way.
#define SCAN_DURATION_MS 800UL
#define SCAN_INTERVAL_MS 10000UL

// --- Cloud -----------------------------------------------------------------
#define CHECKIN_INTERVAL_MS 5000UL
// Also blocking, so keep it well under the check-in interval.
#define HTTP_TIMEOUT_MS     4000UL
#define QUEUE_CAPACITY      24        // events held through a Wi-Fi drop

// --- Time-lapse ------------------------------------------------------------
// Demo mode: the reminder cycle runs this many times faster, so a whole day
// fits in a couple of minutes on stage. Sip detection is unaffected.
#define TIMELAPSE_FACTOR 30
