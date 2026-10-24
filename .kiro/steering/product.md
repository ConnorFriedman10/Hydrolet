# Hydrolet: product

Hydrolet is a hydration reminder system for older adults, especially people with dementia or memory loss, who forget to drink water. It started from a real case: a grandmother hospitalized three times for dehydration after phones, alarms and smartwatches all failed.

## Three parts

- **Watch**: buzzes (sound and vibration) and lights up when it is time to drink. BLE only.
- **Coaster**: her own cup sits on it; a load cell measures how much she drinks. The coaster is the hub: the only device on the internet, and the source of truth for hydration status.
- **Caregiver app**: family set the schedule and goal, and see how she is doing.

## Principles

- The user never sets anything up, charges a phone, or uses a special cup.
- Caregivers get a daily summary plus an alert only when something is wrong, not a flood of notifications.
- The coaster only measures during a reminder. Anything she drinks in between is a bonus. Totals are labeled "water drunk during reminders".
- Many older adults have doctor-set fluid limits, so a caregiver always sets or confirms the daily goal.
- The app describes patterns; it does not give medical advice.

## Scope for the hackathon

In: sip detection and upload, live dashboard, schedule set in the app, coaster and watch lights and reminders, accounts with caregiver codes, daily summary and behind-schedule push notifications, time-lapse mode, "remind her now" button.

Stretch goals are listed in docs/hydrolet-plan.md.
