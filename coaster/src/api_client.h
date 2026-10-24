// Talks to the device-api Edge Function. The coaster never reaches the
// database directly and never holds a Supabase key — just its own device id
// and secret, sent as headers on every request.
#pragma once

#include <Arduino.h>

namespace api {

// One reminder from today's schedule.
struct Reminder {
  char id[40] = "";
  int minutes = -1;   // since midnight, local to the account
  int amountMl = 0;
};

constexpr uint8_t MAX_REMINDERS = 12;

struct Checkin {
  bool ok = false;
  int nowMinutes = -1;              // the account's local time
  Reminder reminders[MAX_REMINDERS];
  uint8_t reminderCount = 0;
  int dailyGoalMl = 0;
  char pendingCommand[24] = "";
};

void begin();

/** Connects, or reconnects after a drop. Safe to call repeatedly. */
bool ensureWifi();

// --- Wi-Fi setup over serial (saved in flash, overrides secrets.h) --------
/** Lists nearby 2.4 GHz networks, numbered for setWifiSsid(). */
void scanNetworks();
/** A network name, or a number from the last scan. False if it was invalid. */
bool setWifiSsid(const String& nameOrNumber);
/** Saves the password and reconnects. Empty for an open network. */
void setWifiPassword(const String& password);
/** Forgets the saved network and goes back to secrets.h. */
void resetWifi();
/** Network, where it came from, connection state, IP, signal and MAC. */
void printWifi();

/**
 * Posts one event. If it fails it is queued and retried later, so a Wi-Fi
 * drop during a reminder loses nothing.
 *   type: "reminder" | "sip" | "refill" | "completed" | "ignored"
 *   reminderSlotId: only on a scheduled "reminder"; empty for remind-now.
 */
void sendEvent(const char* type, const char* reminderId,
               const char* reminderSlotId = "", int amountMl = -1);

/** Heartbeat plus today's schedule and any queued command. */
Checkin checkin(bool watchConnected);

/** Retries anything that failed earlier. Call every loop. */
void drainQueue();

uint8_t queueDepth();

}  // namespace api
