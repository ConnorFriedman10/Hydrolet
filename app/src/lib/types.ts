export type Profile = {
  id: string
  name: string
  caregiver_code: string
  caretaker_of: string[]
  daily_goal_ml: number
  timezone: string
}

export type EventType = 'reminder' | 'sip' | 'refill' | 'completed' | 'ignored'

export type HydroEvent = {
  id: number
  main_id: string
  type: EventType
  amount_ml: number | null
  reminder_id: string | null
  reminder_slot_id: string | null
  created_at: string
}

// One entry in the weekly schedule: a time, the weekdays it fires on, and its
// own water target. days_mask is a 7-bit value, bit 0 = Sunday.
export type ReminderSlot = {
  id: string
  main_id: string
  time_of_day: string   // "09:00:00"
  days_mask: number
  amount_ml: number
}

export type Device = {
  id: string
  owner_id: string
  type: 'coaster' | 'watch'
  last_seen: string | null
  pending_command: string | null
}
