// TEMPLATE — this file IS COMMITTED. Never put real values in it.
// Copy it to secrets.h, which is gitignored, and fill that in instead:
//     cp src/secrets.example.h src/secrets.h
#pragma once

// Must be 2.4 GHz: the ESP32-C3 cannot see 5 GHz. A phone hotspot is the
// safest choice — university and venue networks are usually WPA2-Enterprise
// (which needs a username, and this firmware does not do that) or they
// isolate clients from each other.
#define WIFI_SSID      "your-2.4GHz-hotspot"
#define WIFI_PASSWORD  "your-wifi-password"

// Optional, for a university network with a username and password
// (NUwave, eduroam). Set WIFI_SSID to that network, leave WIFI_PASSWORD as
// "", and uncomment these. Your password sits in plain text in this file and
// in the coaster's flash, so treat the coaster like a logged-in laptop.
// #define WIFI_EAP_USERNAME  "your.name@northeastern.edu"
// #define WIFI_EAP_PASSWORD  "your-university-password"
// #define WIFI_EAP_IDENTITY  "your.name@northeastern.edu"   // defaults to the username
// #define WIFI_EAP_CA_PEM    "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"

#define API_BASE_URL   "https://nfgmrapqkujdcbokmdul.supabase.co/functions/v1/device-api"
#define DEVICE_ID      "device-uuid-from-the-devices-table"
#define DEVICE_SECRET  "secret-shown-once-when-the-device-was-registered"
