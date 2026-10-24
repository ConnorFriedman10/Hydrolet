// Copy to secrets.h (gitignored) and fill in. Never commit secrets.h.
#pragma once

#define WIFI_SSID      "your-2.4GHz-hotspot"   // the ESP32-C3 does not support 5 GHz
#define WIFI_PASSWORD  "your-wifi-password"

#define API_BASE_URL   "https://nfgmrapqkujdcbokmdul.supabase.co/functions/v1/device-api"
#define DEVICE_ID      "device-uuid-from-the-devices-table"
#define DEVICE_SECRET  "secret-shown-once-when-the-device-was-registered"
