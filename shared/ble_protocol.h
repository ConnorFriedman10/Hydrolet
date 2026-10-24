// BLE contract between the coaster (central) and the watch (peripheral).
// Both PlatformIO projects include this via `-I ../shared` in build_flags.
// Change a value here and rebuild both; never hard-code these in either project.
#pragma once

#define HYDROLET_SERVICE_UUID   "3518a23d-30b7-4c54-88a1-eaf73b3cc524"

// Coaster -> watch: one byte, one of the CMD_* values below.
#define HYDROLET_CHAR_COMMAND   "299471a5-cbac-4afb-ad34-2ec6900b0eec"
// Coaster -> watch: current time, sent on each connection.
#define HYDROLET_CHAR_TIME      "dabf06ee-7ca9-4e09-b121-a7508cd0234c"
// Coaster -> watch: reminder schedule (upgrade stage).
#define HYDROLET_CHAR_SCHEDULE  "3159ecae-9cd7-47bd-8f01-680b4ce8459a"
// Watch -> coaster (notify): one byte, one of the EVT_* values below.
#define HYDROLET_CHAR_EVENTS    "ec66bf06-7006-4b2f-92f2-1d7ca727b1bf"

// Command characteristic values.
enum HydroletCommand : unsigned char {
  CMD_REMIND = 1,  // light on, start the three buzzes
  CMD_QUIET  = 2,  // stop buzzing after her first sip; light stays on
  CMD_CLEAR  = 3,  // light off once the target is reached
  CMD_TEST   = 4,
};

// Events characteristic values.
enum HydroletEvent : unsigned char {
  EVT_IGNORED = 1,       // three buzzes finished with no sip
  EVT_BUTTON_PRESS = 2,  // if a button is added
};
