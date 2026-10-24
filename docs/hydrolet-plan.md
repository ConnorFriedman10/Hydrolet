# Hydrolet: Hackathon Plan & Tech Stack

## The problem

Older adults, especially people with dementia or memory loss, often forget to drink water. Dehydration can lead to hospitalization, kidney problems, confusion, and worse. Existing solutions (smartwatches, phone reminders, smart bottles) are too complicated for this group, require a phone, or force them to use a special bottle they can lose.

This project started from a real case: a grandmother with dementia who has been hospitalized three times for dehydration-related illness, after phones, alarms, and smartwatches all failed to help.

## Our solution

Hydrolet is a simple system with three parts. A **watch** on the user's wrist buzzes when it's time to drink. A **coaster** that her own cup sits on measures how much she actually drinks. A **caregiver app** lets family set the schedule and see how she's doing.

The user never has to set anything up, charge a phone, or use a special cup. Caregivers stay informed through a daily summary, plus an alert only when something is wrong, so they aren't flooded with notifications.

## How the system fits together

```
Caregiver app  ⇄  Supabase (cloud)  ⇄  Coaster (Wi-Fi + BLE)  ⇄  Watch (BLE only)
```

The coaster is the hub. It's the only device connected to the internet, so everything going to or from the watch passes through it over Bluetooth Low Energy (BLE).

When a caregiver changes the schedule, the app saves it to Supabase, and the coaster picks up the change the next time it checks in (every few seconds). When she drinks, the coaster sends the amount to Supabase right away, and the app updates live. Watch events go to the coaster over BLE, then up to Supabase.

The coaster is the single source of truth for hydration status and runs the reminder cycle. When it's time to drink, it turns on its own light and tells the watch to remind her. It tracks her sips against that reminder's target amount, and once the target is reached, it turns its light off and tells the watch to clear the reminder.

## Who owns what

The **App** section below belongs to the app lead: the Supabase backend, accounts, the caregiver web app, push notifications, the device API the coaster talks to, and the fake-device tools. The **Hardware** section belongs to the hardware lead: all coaster and watch firmware, including the coaster's requests to the device API. The **Shared** sections are the contract between the two halves and should be agreed on before the event starts.

All code is written in **Kiro**, as required by the hackathon. App screens are mocked up beforehand in **Claude Design** and used as a visual reference only.

---

# Shared

## Shared contracts

These are the only things both halves depend on. If either person needs to change one, tell the other first.

### Database tables (Supabase Postgres)

```
profiles            id (= auth user id), name, caregiver_code (unique), daily_goal_ml, schedule (json)
caregiver_links     caregiver_id, main_id
events              id, main_id, type (reminder/sip/refill/completed/ignored), amount_ml, created_at
summaries           main_id, date, total_ml, goal_ml, reminders_sent, reminders_ignored
devices             id, owner_id, type (coaster/watch), device_secret_hash, last_seen, pending_command
push_subscriptions  user_id, endpoint, p256dh, auth
```

Row-level security ensures a main account's data can only be read or changed by that account and its linked caregivers. Exact column names and the schedule format are fixed before the event.

### Device API (coaster ↔ Supabase)

The coaster never talks to the database directly and never holds Supabase's secret service key. Instead, it calls one small Edge Function, `device-api`, written by the app lead. Each request includes the coaster's device ID and its device secret.

| Request | Sent when | Response |
|---|---|---|
| `POST /event` | A sip, refill, reminder, completed reminder, or ignored reminder happens | OK |
| `POST /checkin` | Every few seconds; includes whether the watch is connected | Current schedule, daily goal, and any pending command |

Each check-in also counts as the heartbeat, updating `last_seen` for the coaster (and the watch, if connected).

### App-to-device commands

The "remind her now" button and time-lapse mode write a command (for example `remindNow` or `timelapse_on`) to the coaster's `pending_command` field. The coaster receives it on its next check-in, acts on it, and the command is cleared. Commands take a few seconds to arrive, which is fine for the demo.

### Watch BLE characteristics (hardware internal)

| Characteristic | Direction | Purpose |
|---|---|---|
| Command | Coaster → watch | "remind" (light on, start the three buzzes), "quiet" (stop buzzing after her first sip; light stays on), "clear" (light off once the target is reached), "test" |
| Time | Coaster → watch | Current time, sent on each connection |
| Schedule | Coaster → watch | Reminder schedule (upgrade stage) |
| Events | Watch → coaster (notify) | Ignored reminders, button presses if added |

## Repo structure

One GitHub repo with a folder for each part. The app lead works in `app/` and `supabase/`, and the hardware lead in `coaster/` and `watch/`, so we rarely edit the same files.

```
hydrolet/
├── README.md                  What the project is, how to run each part
├── .gitignore                 Keeps secrets and build files out of the repo
│
├── .kiro/
│   ├── steering/              Project context Kiro reads on every request
│   │   ├── product.md         The problem, users, and scope
│   │   ├── tech.md            The tech stack
│   │   └── contracts.md       Tables, device API, BLE commands
│   └── specs/                 Kiro's specs (app, coaster, watch)
│
├── docs/
│   ├── plan.md                This plan
│   └── mockups/               Claude Design exports
│
├── app/                       React + Vite PWA (app lead)
│   ├── public/
│   │   ├── manifest.json      Makes the app installable
│   │   ├── sw.js              Service worker for push notifications
│   │   └── icons/
│   ├── src/
│   │   ├── pages/             Login, Dashboard, Schedule, Caregivers, Summary, Install, Dev
│   │   ├── components/
│   │   └── lib/               Supabase client, push subscription helpers
│   ├── .env.example           Lists the variables needed, with no real values
│   └── package.json
│
├── supabase/                  Backend (app lead)
│   ├── migrations/            Tables, security policies, caregiver code function, pg_cron jobs
│   └── functions/
│       ├── device-api/        What the coaster talks to
│       └── send-push/         Sends push notifications
│
├── shared/
│   └── ble_protocol.h         BLE UUIDs and command values, used by both coaster and watch
│
├── coaster/                   PlatformIO project (hardware lead)
│   ├── platformio.ini
│   └── src/
│       ├── main.cpp           Reminder cycle
│       ├── sip_detector.*     Load cell and sip/refill logic
│       ├── lights.*           Green-to-red light
│       ├── watch_link.*       BLE connection to the watch
│       ├── api_client.*       Requests to device-api
│       ├── secrets.h          Wi-Fi password, device secret (not committed)
│       └── secrets.example.h  Same, with placeholder values
│
└── watch/                     PlatformIO project (hardware lead)
    ├── platformio.ini
    └── src/
        ├── main.cpp
        ├── ble_service.*      Receives commands from the coaster
        └── reminder.*         Buzzer, vibration, light, three-buzz timing
```

Files ending in `.*` have a `.h` and a `.cpp`. `supabase/` sits at the root because that's where the Supabase CLI expects it. Both PlatformIO projects include `shared/ble_protocol.h` by adding `-I ../shared` to their build flags, so the coaster and watch can never disagree about UUIDs or command values.

**`.gitignore`** includes `.env`, `secrets.h`, `node_modules/`, `dist/`, `.pio/`, and `supabase/.temp/`. The `.example` versions of secret files are committed, so each person knows what to fill in.

**Working together:** commit and push often, keep `main` working, and pull before starting anything new. Right before the feature freeze, tag the commit (for example `demo`) so we can roll back if a last-minute fix breaks something. Empty folders, `.gitignore`, `README.md`, and the steering files can be created before the event; project scaffolding (`npm create vite`, `pio project init`) waits for the event.

## Open decisions

**Ignored reminders.** How long to wait after the third buzz before logging the reminder as ignored (for example 5 minutes).

## Scope for the 12-hour event

The hardware is already built, so the event time goes to firmware, the app, and the demo.

**In scope:** sip detection on the coaster with upload to Supabase; a live dashboard in the app; the schedule set in the app, with the coaster telling the watch when to buzz; the coaster's light and the watch's reminder light; accounts with caregiver codes; the daily summary and behind-schedule alert as push notifications; time-lapse mode; and the "remind her now" button. Stretch goals are listed at the end of each section.

## Timeline

| Hours | App | Hardware |
|---|---|---|
| 0–3 | Supabase tables, security policies, login, dashboard with fake events; test push notification working on a real phone; first version of `device-api` | Watch BLE tested with nRF Connect; coaster sip detection working over serial |
| 3–5 | Schedule editor; `device-api` finished | Coaster sends events and checks in through `device-api`; coaster ↔ watch link |
| **5** | **Checkpoint: the full loop works.** A sip appears in the app, and a reminder makes the watch buzz | Same checkpoint |
| 5–8 | Caregiver codes, daily summary, behind-schedule alert, push notifications for both | Full reminder cycle, lights, three-buzz sequence and ignored logging |
| 8–9.5 | "Remind her now" button, time-lapse controls, install instructions, UI polish | Pending-command handling, time-lapse mode, enclosure polish |
| **9.5** | **Feature freeze** | **Feature freeze** |
| 9.5–12 | Rehearse, record backup video, lead the pitch | Rehearse, record backup video, run hardware in the demo |

If the loop doesn't work at hour 5, both people stop adding features and fix it together. The feature freeze matters: the last couple of hours always go to something unexpected, and a broken last-minute feature can ruin a working demo.

---

# App (app lead)

## What the app does

A phone-first web app that installs to the home screen as a PWA (progressive web app).

**Login and accounts.** Anyone can create an account from the login page. The person who uses the devices (the grandparent) has the main account, usually set up by a family member on their behalf.

**Caregiver codes.** Every account has a unique caregiver code, similar to a friend code. When another account enters that code, it becomes a caregiver for the main account: caregivers can view the dashboard, change the schedule, and receive the daily summaries. Entering a code goes through a database function (RPC), because security policies stop caregivers from looking up other people's profiles directly. The main account can see and remove its caregivers, and can generate a new code if the old one was shared too widely.

**Dashboard.** Shows today's intake against the goal, a live list of sips and reminders (via Supabase Realtime), and device status ("Coaster: online, Watch: last seen 2 min ago"), based on the `last_seen` heartbeats.

**Schedule.** Caregivers set a daily goal and reminder times. Many older adults are on doctor-set fluid limits (for example, with heart or kidney conditions), so the caregiver always sets or confirms the goal.

**Push notifications.** Each evening, caregivers get a push notification with the key numbers, for example "Today: 1.2 L of 1.5 L goal. 1 reminder ignored." Tapping it opens that day's summary page, with each reminder, when she drank, and how much. Summaries are saved, so caregivers can look back through past days. The total is labeled as water drunk during reminders, since the coaster only measures during reminders. During the day, caregivers get a push notification only if she falls well behind (for example, under 40% of goal by 2pm), which opens the dashboard.

**Demo tools.** A "remind her now" button, time-lapse controls, a "send today's summary now" button, and a hidden dev page that writes fake events ("Simulate sip of 150 mL").

## How it works on phones

Caregivers open the app's link (a QR code on our table for the demo), install it to the home screen, open it from the icon, log in, enter the caregiver code, and tap "Enable notifications."

On **Android**, Chrome offers an "Install app" prompt, and push works right away. On **iPhone**, there's no automatic prompt: users tap Share, then "Add to Home Screen," and push notifications only work after that (iOS 16.4 or later). The app shows these steps on an install instructions screen. Desktop Chrome, Edge, and Firefox also support push, which is handy for the laptop facing the judges.

The phone never talks to the devices directly; everything goes through Supabase, so caregivers can be anywhere.

## How push notifications work

The app uses standard **Web Push**. A one-time pair of VAPID keys identifies the app to push services, with the private key stored as a Supabase secret. A service worker in the app receives pushes and shows notifications, even when the app is closed. When a caregiver taps "Enable notifications," the browser asks for permission, and the app saves the subscription to `push_subscriptions`. The permission request must come from a tap, or iPhones block it.

A `send-push` Edge Function looks up a user's subscriptions and sends the notification with the web-push library, deleting subscriptions that no longer exist. **pg_cron** triggers the daily summary every evening and the behind-schedule check every 15 minutes or so.

If the web-push library gives trouble in Edge Functions (which run on Deno, not Node), the fallback is sending through Firebase Cloud Messaging's API from the same function.

## App tech stack

| Area | Choice | Why |
|---|---|---|
| Framework | React + Vite, as a PWA | Fast to build; installs on phones without separate iOS/Android apps |
| Hosting | Vercel or Netlify | Free, HTTPS by default (required for PWAs and push) |
| Accounts | Supabase Auth | Email login, ties directly into security policies |
| Database | Supabase Postgres with row-level security | Relational fit for caregiver links; access rules enforced in the database |
| Live updates | Supabase Realtime | Dashboard updates the moment a sip arrives |
| Backend logic | Supabase Edge Functions | `device-api` for the coaster, `send-push` for notifications |
| Scheduled jobs | pg_cron | Daily summary and behind-schedule checks |
| Push | Web Push (VAPID) with the web-push library | Standard browser push, no extra service |
| Charts (stretch) | Recharts or Chart.js | Trends page |

Everything here fits in Supabase's free tier, with no credit card required.

## App testing

Build against fake data first: the dev page writes fake sips and reminders, so the app doesn't wait on hardware. Get a test push ("hello") onto a real phone in the first two hours, since push has the most ways to fail. Test on the exact phones we'll demo with, including an iPhone installed to the home screen.

Test the security policies with two or three test accounts: a caregiver can see the main account's data, a stranger can't, and removing a caregiver takes away their access. Read the policies Kiro writes; this is where AI-generated backend code most often goes wrong.

Test `device-api` with a few manual requests (wrong secret rejected, events saved, pending command returned and cleared) before the hardware lead connects the coaster.

## App prep before the event

Create the mockups in Claude Design at phone size (login, dashboard, schedule editor, caregiver code screen, daily summary, install instructions) and export them as images. Create the Supabase project from the dashboard. Install Node and the Supabase CLI. Write Kiro steering files from this doc (tech stack, tables, device API, scope), and check whether the Supabase MCP server connects in Kiro, using a hackathon-only project. Keep all keys in a `.env` file that's listed in `.gitignore`.

## App stretch goals

**Separate editor and viewer roles** for caregivers. **Schedule calculator** that suggests a goal and reminder times for the caregiver to confirm. **Trends page and AI weekly summary** with a week-view chart and a plain-language summary of patterns, such as "She drinks least in the afternoons," kept descriptive rather than medical. **Cup-empty alerts** to caregivers, if the hardware adds cup-empty detection.

---

# Hardware (hardware lead)

## Coaster (ESP32-C3, Wi-Fi + BLE)

**Reminder cycle.** At each scheduled time, the watch buzzes and its light turns on, and the light ring around the coaster turns on. The coaster weighs whatever is on it and saves that as the baseline. Each reminder has a target amount (the daily goal divided by the number of reminders). The watch buzzes three times, one minute apart. The buzzing stops as soon as the coaster detects her first sip, while the lights stay on until the target is reached. If no sip is detected within a few minutes after the third buzz, the reminder is logged as ignored.

The coaster only measures during a reminder. This is intentional: the reminders exist because she may not remember whether she has already drunk, so each reminder makes sure she drinks its target amount. Anything she drinks on her own in between is a bonus.

**Sip detection.** Whenever the cup is lifted and set back down and the reading settles, the coaster compares the new weight to the baseline. If it's lower, the difference is recorded as a sip, and the new weight becomes the baseline. If it's higher, she refilled the cup (or set down a cup that wasn't there before), so nothing is recorded and the new weight becomes the baseline. Readings are averaged and must settle before counting, because load cells are jittery, and changes smaller than a few grams are ignored.

**Light.** As she drinks, the coaster's light gradually shifts from green to red. When the reminder's target is reached, the coaster light and the watch light both turn off until the next reminder.

**Cloud connection.** The coaster talks to the `device-api` Edge Function over HTTPS (see Shared contracts). It sends each event as it happens, and checks in every few seconds to get the schedule, daily goal, and any pending command from the app. Requests that fail (for example, during a Wi-Fi drop) are queued and retried. Keep this code in its own file; the app lead provides the exact URL, request format, and device secret.

## Watch (BLE only)

When it's time to drink, the watch turns on its light and buzzes (sound and vibration) three times, one minute apart, stopping early once she starts drinking. The light stays on until the coaster reports that the reminder's target amount has been drunk, so a glance at her wrist shows whether a reminder is still waiting.

**MVP:** the coaster runs the schedule and tells the watch when to remind. The watch runs the three-buzz timing itself after a "remind" command, and deep-sleeps between events to save battery.

## Hardware tech stack

| Area | Choice | Why |
|---|---|---|
| Firmware | Arduino framework with PlatformIO, inside Kiro | Better than Arduino IDE for team projects |
| Load cell | HX711 library (bogde) | Standard, well documented |
| LEDs | Adafruit NeoPixel (if addressable LEDs) | Simple color control |
| Bluetooth | NimBLE-Arduino | Uses much less memory than the default BLE library, which matters with Wi-Fi + BLE on the C3 |
| Coaster ↔ cloud | ESP32 HTTPClient + ArduinoJson | Plain HTTPS requests to `device-api`; no Supabase library needed |

## Hardware testing

**Watch BLE:** use the free nRF Connect phone app to act as the coaster: write to the command characteristic, and subscribe to events. The Android version can also impersonate the watch, so the coaster can be tested before the watch firmware is done.

**Coaster ↔ Supabase:** use the Supabase dashboard's table editor as a stand-in app. Sips should appear as rows in `events`, and editing the schedule or setting `pending_command` there should reach the coaster on its next check-in.

**Debugging:** log everything over serial with prefixes like `[BLE]`, `[SIP]`, and `[API]`. Add serial commands for fake inputs (for example `sip 150`), so the whole pipeline can be tested without lifting the cup each time.

## Hardware prep before the event

Check the hackathon rules on pre-built hardware. If running unmodified library example sketches is allowed, use them to confirm the watch buzzes and vibrates, the LEDs light, and the load cell gives readings; calibrate the load cell with a known weight and note the demo cup's empty and full weights. Make sure PlatformIO installs in Kiro and can upload to the XIAO boards. Connect both boards to the phone hotspot (set to 2.4 GHz, since the ESP32-C3 doesn't support 5 GHz). Charge the watch battery.

## Hardware stretch goals

**Watch runs the schedule on its own**, using the schedule and time sent by the coaster, so it keeps reminding her out of Bluetooth range and queues events until it reconnects. **Positive feedback**: a happy chime or light pattern when she drinks, and a bigger one when she hits her goal. **Cup-empty detection**: the light pulses when her cup needs a refill. **Recorded family voice reminders** from a speaker on the coaster. **Multiple coasters**, one in the kitchen and one by the bed.

---

# Together

## End-to-end checks

Once both halves work on their own, test as a whole: a schedule change in the app reaches the coaster and watch; a reminder buzzes the watch three times and stops at the first sip; a sip updates the app and the coaster light, and the watch light turns off once the target is reached; ignored reminders get logged; "remind her now" makes the watch buzz within a few seconds; the daily summary arrives as a push notification and opens the summary page; the watch reconnects after going out of range; the coaster recovers from power loss and Wi-Fi drops; sips show up in the app within a few seconds.

**Run the full demo on the exact setup we'll use**: same phone hotspot, same cup, same laptop, same phones. Venue Wi-Fi often blocks devices like ours.

## Demo plan

Open with the story: three hospitalizations, and why existing tech didn't help. Then do the live demo: the watch buzzes, someone drinks from the cup on the coaster, the buzzing stops, the light changes, and the app on a laptop facing the judges updates. Have a judge press "remind her now" and feel the watch buzz. Run time-lapse mode to show a whole day, ending with the daily summary arriving as a push notification on a phone. Close with the price (about $50 vs. a $400+ smartwatch) and the line that sets us apart: **Hydrolet measures real intake from any cup, is built for people with memory loss, and keeps family informed without the user ever touching a phone.**

Keep a backup demo video in case Wi-Fi or Bluetooth fails on stage.
