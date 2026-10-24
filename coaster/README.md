# Coaster firmware

Seeed XIAO ESP32-C3. Four 50 kg half-bridge load cells into one HX711, an
18-pixel WS2812B ring, Wi-Fi to `device-api` and BLE to the watch.

## Wiring

| From | To | Notes |
|---|---|---|
| Load cells (4×) | HX711 `E+ E− A− A+` | The four half bridges combine into one full bridge — one weight for the whole platform |
| HX711 `VCC` / `GND` | XIAO `3V3` / `GND` | |
| HX711 `DT` / `SCK` | XIAO `D3` / `D4` | |
| XIAO `D2` | WS2812B `DIN` | Through 330 Ω, which protects the first pixel |
| XIAO `5V` | WS2812B `5V` | Through 1N4001, with 1000 µF across the strip's rails |
| USB-C 5 V | XIAO | Powers everything |

Grounds must be common between the XIAO and the strip, or the data line has no
reference and the pixels flicker.

## First-time setup

1. `cp src/secrets.example.h src/secrets.h` and fill it in. `secrets.h` is
   gitignored. Wi-Fi must be **2.4 GHz** — the ESP32-C3 cannot see 5 GHz.
2. The device id and secret come from registering a coaster: the `/dev` page
   in the app, or `register_device('coaster')` in SQL. The secret is shown
   once and only its hash is stored, so copy it immediately.
3. Calibrate the scale (below), then `pio run -t upload && pio device monitor`.

## Calibrating the scale

Until this is done every sip will be the wrong size, because the scale reports
raw counts and nothing knows how many of them make a gram.

Upload, open the monitor at 115200, then:

1. **Nothing on the coaster.** Type `tare`.
2. **Put a known weight on it.** A full 500 ml water bottle is 500 g, near
   enough. A kitchen scale and anything heavy works too.
3. **Type `cal 500`** — whatever the real weight in grams is.
4. It prints the counts-per-gram it worked out and saves it.
5. **Check it.** Type `weigh`; it should report the weight you actually put on.
   Try a second, different weight to confirm it tracks.

The factor is stored in flash, so it survives a reboot *and* a reflash — you
never have to copy it back into `config.h`. `status` shows the current value;
at boot the log says `UNCALIBRATED` until the first `cal`.

Heavier is better for accuracy: calibrating with 500 g beats 50 g. While you
have the scale out, note the demo cup's empty and full weights.

1 ml of water weighs 1 g, which is why the firmware treats grams lost as ml drunk.

## Serial commands

Everything can be exercised without lifting a cup. 115200 baud.

| Command | What it does |
|---|---|
| `tare` | Zeroes the scale. Nothing on the coaster |
| `cal 500` | Calibrates against a 500 g weight and saves the result |
| `weigh` | Prints the current weight |
| `sip 150` | Pretends 150 ml was drunk — the full path, including the event upload |
| `remind` | Starts a reminder as if one were scheduled now |
| `test` | Ring self-test, and a test buzz on the watch |
| `timelapse` | Toggles the sped-up demo clock |
| `status` | State, weight, baseline, calibration, watch link, queue, schedule |

Logs are prefixed `[BOOT] [SIP] [BLE] [API] [CYCLE]` so one subsystem can be
followed at a time.

## How a reminder runs

A reminder is due when the account's local time (sent by `/checkin`, so the
coaster needs no clock of its own) reaches a slot's time. Then:

1. The current weight becomes the baseline — it does not matter how full the cup is.
2. The ring comes on green; the watch buzzes, up to three times a minute apart.
3. The first sip stops the buzzing but leaves the lights on.
4. Each sip is uploaded as it happens, and the ring sweeps green → amber → red.
5. At the target: `completed`, ring off, watch cleared.
6. No sip at all after the third buzz: `ignored`.

Weight is only interpreted during a reminder. Between them the coaster still
tracks what is on it, but drinking is not logged — reminders exist because she
may not remember whether she has drunk, so each one stands on its own.

Events that fail to upload are queued and retried, so a Wi-Fi drop mid-reminder
loses nothing.

## Things to know

- **Brightness is capped** in `config.h` for a 1 A supply. 18 pixels at full
  white would draw about 1.1 A on their own and brown out the board. Raise the
  cap only after testing the real adapter.
- **Wi-Fi and BLE share one radio.** Wi-Fi sleep is disabled and BLE scanning is
  throttled, because running both flat out makes each unreliable.
- **The baseline is not persisted.** A reboot mid-reminder re-tares against
  whatever is on the coaster at that moment.
