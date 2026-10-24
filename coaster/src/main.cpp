// Hydrolet coaster.
//
// The coaster is the hub: the only device on the internet, and the thing that
// decides when a reminder happens. It weighs the cup, works out how much she
// drank, drives its own ring, and tells the watch what to do over BLE.
//
// The cycle, per docs/hydrolet-plan.md:
//   a reminder is due -> take the current weight as the baseline, ring on,
//   watch buzzes three times a minute apart -> the first sip stops the buzzing
//   but leaves the lights on -> the ring sweeps green to red as she drinks ->
//   the target is reached, so ring off and the watch clears. If nothing is
//   drunk for a while after the third buzz, the reminder is logged as ignored.
//
// Weight is only interpreted during a reminder. That is deliberate: reminders
// exist because she may not remember whether she has already drunk, so each
// one makes sure she drinks its own amount. Anything else is a bonus.

#include <Arduino.h>
#include <Preferences.h>
#include <esp_random.h>

#include "api_client.h"
#include "config.h"
#include "lights.h"
#include "sip_detector.h"
#include "watch_link.h"

namespace {

enum class State { Idle, Reminding };

State state = State::Idle;

// --- the reminder currently running --------------------------------------
char reminderId[40] = "";       // a new UUID per firing, groups its events
char reminderSlotId[40] = "";   // empty for an on-demand "Send a reminder now"
int targetMl = 0;
int drunkMl = 0;
unsigned long lastBuzzAt = 0;
uint8_t buzzesSent = 0;
bool sawFirstSip = false;

// --- today's schedule, from the last check-in -----------------------------
api::Checkin schedule;
char firedToday[api::MAX_REMINDERS][40];
uint8_t firedCount = 0;
char firedDate[11] = "";        // the local date firedToday belongs to
int lastNowMinutes = -1;

// --- survives a restart ----------------------------------------------------
// Which of today's reminders already fired, and the reminder that was running
// when the power went. Without this, a restart replays every reminder from
// the last MISSED_GRACE_MIN minutes, and the interrupted one stays open on the
// dashboard forever because nothing ever closes it.
Preferences cycle;

void saveFired() {
  String joined;
  for (uint8_t i = 0; i < firedCount; i++) {
    if (i) joined += ',';
    joined += firedToday[i];
  }
  cycle.putString("date", firedDate);
  cycle.putString("fired", joined);
}

void loadFired() {
  firedCount = 0;
  if (!cycle.isKey("date")) return;
  strlcpy(firedDate, cycle.getString("date").c_str(), sizeof(firedDate));
  const String joined = cycle.isKey("fired") ? cycle.getString("fired") : String();
  int from = 0;
  while (from < (int)joined.length() && firedCount < api::MAX_REMINDERS) {
    int comma = joined.indexOf(',', from);
    if (comma < 0) comma = joined.length();
    if (comma > from) strlcpy(firedToday[firedCount++], joined.substring(from, comma).c_str(), 40);
    from = comma + 1;
  }
}

/** Records the running reminder (or none), and how much has been drunk in it. */
void saveOpen() {
  cycle.putString("open", state == State::Reminding ? reminderId : "");
  cycle.putInt("openMl", drunkMl);
}

/**
 * How to close a reminder that ends before reaching its target: "completed"
 * if anything was drunk (the dashboard shows the amount, e.g. "80 of 250 mL"),
 * "ignored" if nothing was.
 */
const char* closingFor(int drankMl) { return drankMl > 0 ? "completed" : "ignored"; }

/** At boot: close the reminder a restart cut off, so it does not stay open. */
void closeInterrupted() {
  if (!cycle.isKey("open")) return;
  const String open = cycle.getString("open");
  if (open.isEmpty()) return;
  const int drank = cycle.getInt("openMl", 0);
  // Queued until Wi-Fi is up, like any event.
  api::sendEvent(closingFor(drank), open.c_str(), "", -1);
  Serial.printf("[CYCLE] closed the reminder a restart interrupted (%s, %d mL)\n",
                closingFor(drank), drank);
  cycle.putString("open", "");
}

unsigned long lastCheckinAt = 0;
bool timelapse = false;

/** Scales a duration when time-lapse is on, so a day fits in the demo. */
unsigned long scaled(unsigned long ms) {
  return timelapse ? ms / TIMELAPSE_FACTOR : ms;
}

/** RFC 4122 v4, which is what the events table expects. */
void makeUuid(char* out) {
  const char* hex = "0123456789abcdef";
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { out[i] = '-'; continue; }
    if (i == 14) { out[i] = '4'; continue; }
    uint8_t v = esp_random() & 0x0F;
    if (i == 19) v = (v & 0x3) | 0x8;
    out[i] = hex[v];
  }
  out[36] = '\0';
}

bool alreadyFired(const char* slotId) {
  for (uint8_t i = 0; i < firedCount; i++) {
    if (strcmp(firedToday[i], slotId) == 0) return true;
  }
  return false;
}

void markFired(const char* slotId) {
  if (firedCount < api::MAX_REMINDERS) strlcpy(firedToday[firedCount++], slotId, 40);
  saveFired();
}

void startReminder(const char* slotId, int amountMl) {
  makeUuid(reminderId);
  strlcpy(reminderSlotId, slotId, sizeof(reminderSlotId));
  targetMl = amountMl > 0 ? amountMl : REMIND_NOW_ML;
  drunkMl = 0;
  sawFirstSip = false;
  buzzesSent = 0;
  lastBuzzAt = 0;
  state = State::Reminding;

  // Whatever is on the coaster right now is what the next sip is measured
  // against — it does not matter how full the cup happens to be.
  sip::resetBaseline();

  lights::showProgress(0.0f);
  api::sendEvent("reminder", reminderId, reminderSlotId, -1);
  saveOpen();

  Serial.printf("[CYCLE] reminder started, target %d mL%s\n",
                targetMl, *reminderSlotId ? "" : " (on demand)");
}

void finishReminder(const char* how) {
  // Lights and watch first, upload after, for the same reason as in handleWeight().
  watch::clear();
  // She drank enough: say so. Ignored: just go dark.
  if (strcmp(how, "completed") == 0) lights::celebrate();
  else lights::off();
  state = State::Idle;
  saveOpen();
  api::sendEvent(how, reminderId, "", -1);
  Serial.printf("[CYCLE] reminder %s (%d of %d mL)\n", how, drunkMl, targetMl);
}

void handleCommand(const char* command) {
  if (!*command) return;
  Serial.printf("[CYCLE] command: %s\n", command);

  if (strcmp(command, "remindNow") == 0) {
    // No slot behind it, so no planned amount: use the stand-in target.
    if (state == State::Idle) startReminder("", REMIND_NOW_ML);
  } else if (strcmp(command, "timelapse_on") == 0) {
    timelapse = true;
  } else if (strcmp(command, "timelapse_off") == 0) {
    timelapse = false;
  }
}

/**
 * Fires any scheduled reminder whose time has come. A newly due reminder
 * always goes out: if another one is still running (a "Send a reminder now",
 * or an earlier slot nobody finished), that one is closed first.
 */
void checkSchedule() {
  if (schedule.nowMinutes < 0) return;

  for (uint8_t i = 0; i < schedule.reminderCount; i++) {
    const api::Reminder& r = schedule.reminders[i];
    if (r.minutes > schedule.nowMinutes) continue;   // not yet
    if (alreadyFired(r.id)) continue;
    markFired(r.id);

    // Long past: the coaster was off, or the slot was just added with a time
    // earlier today. Firing it now would set off a burst of stale reminders
    // at boot, so skip it; the next one on the schedule still runs.
    if (schedule.nowMinutes - r.minutes > MISSED_GRACE_MIN) {
      Serial.printf("[CYCLE] skipped %02d:%02d, more than %d min ago\n",
                    r.minutes / 60, r.minutes % 60, MISSED_GRACE_MIN);
      continue;
    }

    if (state == State::Reminding) {
      Serial.printf("[CYCLE] %02d:%02d is due: closing the reminder still running\n",
                    r.minutes / 60, r.minutes % 60);
      finishReminder(closingFor(drunkMl));
    }

    startReminder(r.id, r.amountMl);
    return;   // one at a time; the schedule forbids two at the same minute
  }
}

void runCheckin() {
  api::Checkin fresh = api::checkin(watch::connected());
  if (!fresh.ok) return;

  // A different date means a new day, so the fired list (kept across
  // restarts) no longer applies. A server too old to send the date falls back
  // to "the clock went backwards".
  const bool newDay = *fresh.date
      ? strcmp(fresh.date, firedDate) != 0
      : (fresh.nowMinutes >= 0 && fresh.nowMinutes < lastNowMinutes);
  if (newDay) {
    // First start of this firmware: nothing was saved, so there is no telling
    // what already fired today. Count everything already due as done rather
    // than replaying it.
    const bool firstRun = !cycle.isKey("date");
    firedCount = 0;
    strlcpy(firedDate, fresh.date, sizeof(firedDate));
    if (firstRun) {
      for (uint8_t i = 0; i < fresh.reminderCount && firedCount < api::MAX_REMINDERS; i++) {
        if (fresh.reminders[i].minutes <= fresh.nowMinutes) {
          strlcpy(firedToday[firedCount++], fresh.reminders[i].id, 40);
        }
      }
    }
    saveFired();
    Serial.printf("[CYCLE] new day %s%s\n", firedDate,
                  firstRun ? " (first start: reminders already due are counted as done)" : "");
  }
  lastNowMinutes = fresh.nowMinutes;

  const String command(fresh.pendingCommand);
  schedule = fresh;
  handleCommand(command.c_str());
}

/** The reminder's own timing: three buzzes, then the ignored timeout. */
void runReminderTiming() {
  if (state != State::Reminding) return;
  const unsigned long now = millis();

  if (!sawFirstSip && buzzesSent < BUZZ_COUNT &&
      (buzzesSent == 0 || now - lastBuzzAt >= scaled(BUZZ_INTERVAL_MS))) {
    watch::remind();
    lastBuzzAt = now;
    buzzesSent++;
    Serial.printf("[CYCLE] buzz %u of %d\n", buzzesSent, BUZZ_COUNT);
  }

  if (watch::takeIgnoredFlag() && !sawFirstSip) {
    finishReminder("ignored");
    return;
  }

  // Nothing at all after the last buzz: she did not respond.
  if (!sawFirstSip && buzzesSent >= BUZZ_COUNT &&
      now - lastBuzzAt >= scaled(IGNORED_TIMEOUT_MS)) {
    finishReminder("ignored");
  }
}

void handleWeight() {
  const sip::Event change = sip::poll();
  if (change.type == sip::Change::None) return;

  if (state != State::Reminding) {
    // Outside a reminder the coaster still tracks the weight so it knows what
    // is there, but drinking is not logged. Only reminders count.
    return;
  }

  if (change.type == sip::Change::Refill) {
    api::sendEvent("refill", reminderId, "", -1);
    Serial.println(F("[SIP] refill"));
    return;
  }

  const int ml = (int)lroundf(change.amountMl);
  if (ml <= 0) return;
  drunkMl += ml;
  saveOpen();   // so a restart now closes this reminder as drunk-from, not ignored
  Serial.printf("[SIP] %d mL (%d of %d)\n", ml, drunkMl, targetMl);

  // What she can see and feel comes first. The upload below blocks for up to
  // HTTP_TIMEOUT_MS, and doing it first held the ring and the watch back by
  // that long after every sip.
  lights::blinkSip();
  lights::showProgress((float)drunkMl / (float)targetMl);
  if (!sawFirstSip) {
    sawFirstSip = true;
    watch::quiet();   // she is drinking; stop buzzing, leave the light on
  }

  // Sent one at a time, as they happen, so the app's reminder fills in live
  // rather than jumping at the end.
  api::sendEvent("sip", reminderId, "", ml);

  if (drunkMl >= targetMl) finishReminder("completed");
}

/** Serial commands, so the whole pipeline can be exercised without a cup. */
void handleSerial() {
  // Collect characters as they arrive and act only on Enter. The monitor sends
  // one keystroke at a time, so a blocking readStringUntil() would time out
  // mid-word and split a slowly typed command into pieces.
  static String buffer;
  bool complete = false;
  while (Serial.available()) {
    const char c = (char)Serial.read();
    if (c == '\r' || c == '\n') { if (buffer.length()) { complete = true; break; } continue; }
    if (buffer.length() < 100) buffer += c;   // room for `pass` + a 63-char WPA key
  }
  if (!complete) return;

  String line = buffer;
  buffer = "";
  line.trim();
  if (line.isEmpty()) return;
  Serial.printf("> %s\n", line.c_str());

  if (line.startsWith("sip ")) {
    sip::injectForTesting(line.substring(4).toFloat());
  } else if (line == "remind") {
    if (state == State::Idle) startReminder("", REMIND_NOW_ML);
  } else if (line == "test") {
    lights::selfTest();
    watch::test();
  } else if (line == "sweep") {
    // The whole reminder's light show in 8 seconds: green to red, then the finish.
    for (int i = 0; i <= 20; i++) { lights::showProgress(i / 20.0f); delay(350); }
    lights::celebrate();
    Serial.println(F("[LED] sweep done, finish animation running"));
  } else if (line == "ledcount") {
    Serial.printf("[LED] lighting 200 pixels for 20 s (configured: %d). Every 10th is red.\n", LED_COUNT);
    lights::countTest(200, 20000);
    Serial.println(F("[LED] count test done"));
  } else if (line == "tare") {
    sip::tareScale();
  } else if (line.startsWith("cal ")) {
    const float grams = line.substring(4).toFloat();
    if (!sip::calibrate(grams)) {
      Serial.println(F("[SIP] calibration failed — is the weight on the coaster?"));
    }
  } else if (line == "weigh") {
    Serial.printf("[SIP] %.1f g\n", sip::lastWeightG());
  } else if (line == "ble") {
    watch::scanReport(4000);
  } else if (line == "wifi") {
    api::printWifi();
  } else if (line == "wifi scan") {
    api::scanNetworks();
  } else if (line == "wifi reset") {
    api::resetWifi();
  } else if (line.startsWith("ssid ")) {
    String name = line.substring(5);
    name.trim();
    if (!api::setWifiSsid(name)) Serial.println(F("[API] no such network; run 'wifi scan' first"));
  } else if (line == "pass" || line.startsWith("pass ")) {
    // Not trimmed: a password can end in a space.
    api::setWifiPassword(line.length() > 5 ? line.substring(5) : String());
  } else if (line == "timelapse") {
    timelapse = !timelapse;
    Serial.printf("[CYCLE] time-lapse %s\n", timelapse ? "on" : "off");
  } else if (line == "status") {
    Serial.printf("[STATUS] state=%s weight=%.1fg baseline=%.1fg cal=%.2f watch=%s "
                  "queue=%u now=%d reminders=%u\n",
                  state == State::Idle ? "idle" : "reminding",
                  sip::lastWeightG(), sip::baselineG(), sip::calibrationFactor(),
                  watch::connected() ? "yes" : "no",
                  api::queueDepth(), schedule.nowMinutes, schedule.reminderCount);
  } else {
    Serial.println(F("commands: tare | cal <grams> | weigh | sip <ml> | remind | "
                     "test | timelapse | status | wifi | wifi scan | ssid <name or #> | "
                     "pass <password> | wifi reset"));
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n[BOOT] Hydrolet coaster"));

  lights::begin();
  lights::selfTest();
  sip::begin();
  watch::begin();
  api::begin();

  cycle.begin("cycle", false);
  loadFired();
  if (firedCount) Serial.printf("[CYCLE] %u reminders already fired on %s\n", firedCount, firedDate);
  closeInterrupted();

  Serial.println(F("[BOOT] ready — type 'status' for state"));
}

void loop() {
  watch::tick(api::online());
  lights::tick();
  handleWeight();
  runReminderTiming();
  handleSerial();

  if (millis() - lastCheckinAt >= CHECKIN_INTERVAL_MS) {
    lastCheckinAt = millis();
    api::ensureWifi();
    runCheckin();
    // The clock only moves on a check-in, so this is the only place a
    // scheduled reminder can become due.
    checkSchedule();
    api::drainQueue();
  }
}
