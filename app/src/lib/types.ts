export type Profile = {
  id: string
  name: string
  caregiver_code: string
  caretaker_of: string[]
  daily_goal_ml: number
  schedule: { reminders: string[] }
  timezone: string
}

export type EventType = 'reminder' | 'sip' | 'refill' | 'completed' | 'ignored'

export type HydroEvent = {
  id: number
  main_id: string
  type: EventType
  amount_ml: number | null
  reminder_id: string | null
  created_at: string
}

export type Device = {
  id: string
  owner_id: string
  type: 'coaster' | 'watch'
  last_seen: string | null
  pending_command: string | null
}
