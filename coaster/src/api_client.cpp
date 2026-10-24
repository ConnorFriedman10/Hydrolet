#include "api_client.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "config.h"
#include "secrets.h"

namespace api {
namespace {

struct Queued {
  char body[192];
};

Queued queue[QUEUE_CAPACITY];
uint8_t queueHead = 0, queueCount = 0;

/** "09:05" -> 545. -1 if it doesn't look like a time. */
int parseMinutes(const char* hhmm) {
  if (!hhmm || strlen(hhmm) < 4) return -1;
  int h = atoi(hhmm);
  const char* colon = strchr(hhmm, ':');
  if (!colon) return -1;
  return h * 60 + atoi(colon + 1);
}

/** Returns the HTTP status, or a negative number on a transport failure. */
int post(const char* path, const String& body, String* responseOut) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  WiFiClientSecure client;
  // Good enough for the event. For anything real, pin Supabase's root cert.
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  String url = String(API_BASE_URL) + path;
  if (!http.begin(client, url)) return -2;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Device-Secret", DEVICE_SECRET);

  const int status = http.POST(body);
  if (responseOut && status > 0) *responseOut = http.getString();
  http.end();
  return status;
}

/**
 * The server looked at the event and refused it (bad body, unknown route).
 * Retrying cannot help. 401 is not included: a wrong secret is a setup
 * mistake, and once it is fixed the queued events should still go through.
 * 408 and 429 mean "try later".
 */
bool isPermanentFailure(int status) {
  return status >= 400 && status < 500 && status != 401 && status != 408 && status != 429;
}

void enqueue(const String& body) {
  if (queueCount >= QUEUE_CAPACITY) {
    // Full: drop the oldest. Losing the start of a long outage beats losing
    // the sip that just happened.
    queueHead = (queueHead + 1) % QUEUE_CAPACITY;
    queueCount--;
    Serial.println(F("[API] queue full, dropped oldest"));
  }
  const uint8_t slot = (queueHead + queueCount) % QUEUE_CAPACITY;
  strlcpy(queue[slot].body, body.c_str(), sizeof(queue[slot].body));
  queueCount++;
  Serial.printf("[API] queued, depth %u\n", queueCount);
}

}  // namespace

// --- Wi-Fi credentials -----------------------------------------------------
// secrets.h holds the defaults. The `ssid` / `pass` serial commands save an
// override in flash, so the network can change without a reflash — the same
// way the scale calibration is stored.
namespace {

Preferences wifiPrefs;
String wifiSsid, wifiPass;
bool wifiFromFlash = false;
unsigned long nextAttempt = 0;
uint8_t lastReason = 0;
volatile bool ownDisconnect = false;   // set while we abort an attempt ourselves
bool lastFailedNotFound = false;       // last attempt ended "network not found"

constexpr uint8_t MAX_SCAN = 20;
String scanned[MAX_SCAN];
bool scannedEnterprise[MAX_SCAN];   // needs a username/password login (NUwave)
uint8_t scannedCount = 0;

void loadCredentials() {
  wifiPrefs.begin("wifi", true);
  wifiFromFlash = wifiPrefs.isKey("ssid");
  wifiSsid = wifiFromFlash ? wifiPrefs.getString("ssid") : String(WIFI_SSID);
  // `ssid` alone keeps the secrets.h password, so picking a network by number
  // is enough when only the name was wrong.
  wifiPass = wifiPrefs.isKey("pass") ? wifiPrefs.getString("pass") : String(WIFI_PASSWORD);
  wifiPrefs.end();
}

/** What a disconnect reason means, for the ones that actually come up. */
const char* reasonText(uint8_t r) {
  switch (r) {
    case 2: case 15: case 204: return "wrong password (handshake failed)";
    case 201: return "network not found (name mismatch, or 5 GHz only)";
    case 202: return "authentication rejected";
    case 203: return "association failed";
    case 200: return "beacon timeout (weak signal or hotspot went to sleep)";
    case 8: return "left the network";
    default: return "see esp_wifi_types.h";
  }
}

/**
 * A network name reduced to lowercase letters and digits, so names that differ
 * only in case, spacing, punctuation or apostrophe style compare equal:
 * "Henry's iPhone (2)" and the iPhone's own "Henry’s iPhone (2)" both become
 * "henrysiphone2". Non-ASCII bytes (the curly apostrophe is three of them)
 * are dropped along with punctuation.
 */
String simplified(const String& name) {
  String out;
  for (unsigned int i = 0; i < name.length(); i++) {
    const char c = name[i];
    if (c >= 'A' && c <= 'Z') out += (char)(c - 'A' + 'a');
    else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out += c;
  }
  return out;
}

/**
 * The network to join: the configured name if the last scan heard it,
 * otherwise a heard network whose simplified name matches. Falls back to the
 * configured name, so a hidden network still gets tried.
 */
String resolveSsid() {
  for (uint8_t i = 0; i < scannedCount; i++) {
    if (scanned[i] == wifiSsid) return wifiSsid;
  }
  const String want = simplified(wifiSsid);
  if (want.length() > 0) {
    for (uint8_t i = 0; i < scannedCount; i++) {
      if (simplified(scanned[i]) == want) {
        Serial.printf("[API] '%s' not heard; using similar network '%s'\n",
                      wifiSsid.c_str(), scanned[i].c_str());
        return scanned[i];
      }
    }
  }
  return wifiSsid;
}

/** Fills the scan list. Verbose prints every network; quiet just refreshes. */
void scanInto(bool verbose) {
  // A scan cannot run while a join is in progress.
  WiFi.disconnect(false, false);
  const int n = WiFi.scanNetworks();
  scannedCount = 0;
  for (int i = 0; i < n && i < MAX_SCAN; i++) {
    scannedEnterprise[scannedCount] = WiFi.encryptionType(i) == WIFI_AUTH_WPA2_ENTERPRISE
                                      || WiFi.encryptionType(i) == WIFI_AUTH_WPA3_ENTERPRISE
                                      || WiFi.encryptionType(i) == WIFI_AUTH_WPA2_WPA3_ENTERPRISE;
    scanned[scannedCount++] = WiFi.SSID(i);
  }
  if (verbose) {
    Serial.printf("[API] scan: %d networks (2.4 GHz only — 5 GHz is invisible to this chip)\n", n < 0 ? 0 : n);
    for (int i = 0; i < n && i < MAX_SCAN; i++) {
      const bool match = simplified(WiFi.SSID(i)) == simplified(wifiSsid);
      Serial.printf("[API] %2d %s %-32s ch%-2d %4ddBm %s\n", i + 1, match ? "*" : " ",
                    WiFi.SSID(i).c_str(), WiFi.channel(i), WiFi.RSSI(i),
                    WiFi.encryptionType(i) == WIFI_AUTH_WPA2_ENTERPRISE ? "enterprise" : "");
    }
  }
  WiFi.scanDelete();
}

}  // namespace

void scanNetworks() {
  scanInto(true);
  bool heard = false;
  for (uint8_t i = 0; i < scannedCount; i++) heard |= simplified(scanned[i]) == simplified(wifiSsid);
  if (!heard) {
    Serial.printf("[API] '%s' (or anything like it) is not in the scan: check the name, and that "
                  "the hotspot is on 2.4 GHz (iPhone: Maximize Compatibility)\n", wifiSsid.c_str());
  }
  nextAttempt = 0;   // reconnect straight away
}

void begin() {
  loadCredentials();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // BLE shares this radio; sleep makes both erratic
  // ensureWifi() owns retries. Letting the driver retry on its own as well
  // leaves it mid-join, and every later begin() then fails with
  // "sta is connecting, cannot set config".
  WiFi.setAutoReconnect(false);
  // By default the driver joins the first access point it hears. On campus
  // that can be one three rooms away at -80 dBm while one next door is at
  // -50, so scan every channel and pick the strongest.
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);

  WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t info) {
    const uint8_t r = info.wifi_sta_disconnected.reason;
    // 8 is our own disconnect() before a retry. Recording it would hide the
    // reason the previous attempt really failed.
    if (r == 8 && ownDisconnect) return;
    lastReason = r;
    Serial.printf("[API] wifi disconnected: reason %u, %s\n", r, reasonText(r));
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t) {
    Serial.println(F("[API] wifi associated, waiting for login/IP"));
  }, ARDUINO_EVENT_WIFI_STA_CONNECTED);

  Serial.printf("[API] mac %s\n", WiFi.macAddress().c_str());
  scanNetworks();
  ensureWifi();
}

/**
 * Never blocks. It starts a connection attempt and returns; the radio
 * connects in the background. Waiting here would stall the whole loop, and
 * with bad credentials it would stall it forever — serial commands included.
 */
bool ensureWifi() {
  static bool wasConnected = false;

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasConnected) {
      wasConnected = true;
      Serial.printf("[API] wifi up on '%s', ip %s, %d dBm\n", WiFi.SSID().c_str(),
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
    }
    return true;
  }

  if (wasConnected) {
    wasConnected = false;
    Serial.println(F("[API] wifi dropped"));
  }

  if (millis() >= nextAttempt) {
    // Enterprise logins go through the university's login server and can take
    // several seconds, so give each attempt longer before cutting it off.
    nextAttempt = millis() + 25000;
    if (lastReason) {
      Serial.printf("[API] last attempt failed: reason %u, %s\n", lastReason, reasonText(lastReason));
      lastFailedNotFound = lastReason == 201;
      lastReason = 0;
    }
    // Abandon whatever attempt is still pending, so this one is not refused.
    ownDisconnect = true;
    WiFi.disconnect(false, false);
    delay(100);
    ownDisconnect = false;

    // Last attempt said "network not found", or nothing has been scanned yet:
    // look again, so a near-miss name (apostrophe style, case, spacing) can
    // be matched to what is actually on the air.
    if (lastFailedNotFound || scannedCount == 0) scanInto(false);
    lastFailedNotFound = false;
    const String target = resolveSsid();

#ifdef WIFI_EAP_USERNAME
    // Enterprise login (NUwave, eduroam): a username and password checked by
    // the university's server, instead of one shared Wi-Fi password. Used
    // only when the scan shows the network really asks for one, so the EAP
    // lines in secrets.h can stay put while joining an ordinary hotspot.
    bool enterprise = false;
    for (uint8_t i = 0; i < scannedCount; i++) {
      if (scanned[i] == target) enterprise = scannedEnterprise[i];
    }
    if (enterprise) {
#ifndef WIFI_EAP_IDENTITY
#define WIFI_EAP_IDENTITY WIFI_EAP_USERNAME
#endif
#ifdef WIFI_EAP_CA_PEM
      const char* ca = WIFI_EAP_CA_PEM;
#else
      const char* ca = nullptr;
      Serial.println(F("[API] warning: no WIFI_EAP_CA_PEM, so the network's identity is not checked"));
#endif
      Serial.printf("[API] connecting to '%s' (WPA2-Enterprise PEAP, as %s)\n",
                    target.c_str(), WIFI_EAP_USERNAME);
      WiFi.begin(target.c_str(), WPA2_AUTH_PEAP, WIFI_EAP_IDENTITY, WIFI_EAP_USERNAME,
                 WIFI_EAP_PASSWORD, ca);
      return false;
    }
#endif

    Serial.printf("[API] connecting to '%s'\n", target.c_str());
    WiFi.begin(target.c_str(), wifiPass.c_str());
  }
  return false;
}

bool setWifiSsid(const String& nameOrNumber) {
  String name = nameOrNumber;
  const int n = nameOrNumber.toInt();
  // A bare number picks from the last scan, which avoids typing names with
  // curly apostrophes and emoji (iPhone hotspots) into a serial monitor.
  if (n > 0 && String(n) == nameOrNumber) {
    if (n > scannedCount) return false;
    name = scanned[n - 1];
  }
  if (name.isEmpty()) return false;
  wifiSsid = name;
  wifiPrefs.begin("wifi", false);
  wifiPrefs.putString("ssid", wifiSsid);
  wifiPrefs.end();
  wifiFromFlash = true;
  Serial.printf("[API] ssid set to '%s' (saved), reconnecting with the current password. "
                "Different password? pass <password>\n", wifiSsid.c_str());
  nextAttempt = 0;
  return true;
}

void setWifiPassword(const String& password) {
  wifiPass = password;
  wifiPrefs.begin("wifi", false);
  if (!wifiPrefs.isKey("ssid")) wifiPrefs.putString("ssid", wifiSsid);
  wifiPrefs.putString("pass", wifiPass);
  wifiPrefs.end();
  wifiFromFlash = true;
  Serial.printf("[API] password saved (%u chars), reconnecting\n", wifiPass.length());
  nextAttempt = 0;
}

void resetWifi() {
  wifiPrefs.begin("wifi", false);
  wifiPrefs.clear();
  wifiPrefs.end();
  loadCredentials();
  Serial.printf("[API] saved wifi forgotten, back to secrets.h ('%s')\n", wifiSsid.c_str());
  nextAttempt = 0;
}

void printWifi() {
  Serial.printf("[API] wifi '%s' (from %s, password %u chars) %s",
                wifiSsid.c_str(), wifiFromFlash ? "flash" : "secrets.h", wifiPass.length(),
                WiFi.status() == WL_CONNECTED ? "connected" : "NOT connected");
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf(", ip %s, %d dBm", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }
  Serial.printf(", mac %s\n", WiFi.macAddress().c_str());
}

void sendEvent(const char* type, const char* reminderId,
               const char* reminderSlotId, int amountMl) {
  JsonDocument doc;
  doc["type"] = type;
  if (reminderId && *reminderId) doc["reminder_id"] = reminderId;
  if (reminderSlotId && *reminderSlotId) doc["reminder_slot_id"] = reminderSlotId;
  if (amountMl >= 0) doc["amount_ml"] = amountMl;

  String body;
  serializeJson(doc, body);

  const int status = post("/event", body, nullptr);
  if (status >= 200 && status < 300) {
    Serial.printf("[API] %s sent\n", type);
  } else if (isPermanentFailure(status)) {
    Serial.printf("[API] %s rejected (%d), dropped: %s\n", type, status, body.c_str());
  } else {
    Serial.printf("[API] %s failed (%d), queueing\n", type, status);
    enqueue(body);
  }
}

Checkin checkin(bool watchConnected) {
  Checkin out;

  JsonDocument req;
  req["watch_connected"] = watchConnected;
  String body;
  serializeJson(req, body);

  String response;
  const int status = post("/checkin", body, &response);
  if (status < 200 || status >= 300) {
    Serial.printf("[API] checkin failed (%d)\n", status);
    return out;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    Serial.println(F("[API] checkin: bad JSON"));
    return out;
  }

  out.ok = true;
  out.nowMinutes = parseMinutes(doc["now"] | "");
  out.dailyGoalMl = doc["daily_goal_ml"] | 0;
  strlcpy(out.pendingCommand, doc["pending_command"] | "", sizeof(out.pendingCommand));

  for (JsonObject r : doc["today_reminders"].as<JsonArray>()) {
    if (out.reminderCount >= MAX_REMINDERS) break;
    Reminder& slot = out.reminders[out.reminderCount];
    strlcpy(slot.id, r["id"] | "", sizeof(slot.id));
    slot.minutes = parseMinutes(r["time"] | "");
    slot.amountMl = r["amount_ml"] | 0;
    if (slot.minutes >= 0) out.reminderCount++;
  }
  return out;
}

void drainQueue() {
  if (queueCount == 0 || WiFi.status() != WL_CONNECTED) return;

  // One per call, so a long backlog never stalls the reminder cycle.
  const String body(queue[queueHead].body);
  const int status = post("/event", body, nullptr);
  const bool sent = status >= 200 && status < 300;
  if (sent || isPermanentFailure(status)) {
    // A rejected event will be rejected forever; keeping it would block
    // everything queued behind it.
    if (!sent) Serial.printf("[API] queued event rejected (%d), dropped: %s\n", status, body.c_str());
    queueHead = (queueHead + 1) % QUEUE_CAPACITY;
    queueCount--;
    if (sent) Serial.printf("[API] queued event sent, %u left\n", queueCount);
  }
}

uint8_t queueDepth() { return queueCount; }

bool online() { return WiFi.status() == WL_CONNECTED; }

}  // namespace api
