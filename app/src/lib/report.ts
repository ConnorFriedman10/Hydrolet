// The daily report: turns the facts saved by build_daily_report() into short
// sentences about the day's drinking patterns.
//
// Wording rules: describe what happened, never advise. No pronouns: the same
// report is read by the person and by their caregivers, so sentences are
// phrased without "she", "he", "they" or "you".
//
// Pure logic, kept out of the component so it can be unit-tested.

export type Period = 'morning' | 'afternoon' | 'evening'
export type Outcome = 'completed' | 'ignored' | 'open'

export type ReportFacts = {
  date: string
  day_complete: boolean
  goal_ml: number
  planned_ml: number
  total_ml: number
  reminders: {
    sent: number
    completed: number
    ignored: number
    open: number
    unscheduled: number
    missed: number
  }
  sips: { count: number; average_ml: number | null; largest_ml: number | null }
  first_sip_median_min: number | null
  complete_median_min: number | null
  periods: { name: Period; planned_ml: number; drank_ml: number; sent: number; ignored: number }[]
  week: { days: number; average_ml: number | null; goal_met_days: number }
  firings: {
    time: string            // "16:23", local
    scheduled: boolean
    target_ml: number | null
    drank_ml: number
    outcome: Outcome
    first_sip_min: number | null
  }[]
}

export type DailyReport = {
  main_id: string
  date: string
  report: ReportFacts
  generated_at: string
}

/** 1200 -> "1.2 L", 850 -> "850 mL". Same as the notifications. */
export function volume(ml: number): string {
  if (ml < 1000) return `${Math.round(ml)} mL`
  return `${Math.round(ml / 100) / 10} L`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** 0.4 -> "under a minute", 2.3 -> "about 2 minutes". */
function minutes(m: number): string {
  if (m < 1) return 'under a minute'
  const r = Math.round(m)
  return `about ${plural(r, 'minute')}`
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/**
 * The headline: how much was drunk during reminders, against what the day's
 * reminders planned and the doctor-confirmed daily goal.
 */
export function headline(r: ReportFacts): string {
  if (r.reminders.sent === 0 && r.total_ml === 0) {
    return r.reminders.missed > 0
      ? 'No reminders went off this day.'
      : 'Nothing was scheduled or drunk during reminders this day.'
  }
  const vsPlan = r.planned_ml > 0
    ? `, ${percent(r.total_ml, r.planned_ml)}% of the ${volume(r.planned_ml)} planned`
    : ''
  return `${volume(r.total_ml)} drunk during reminders${vsPlan}.`
}

/** The pattern sentences, most useful first. Empty for a day with nothing in it. */
export function describe(r: ReportFacts): string[] {
  const out: string[] = []
  const rem = r.reminders

  if (rem.sent === 0 && rem.missed === 0) return out

  // Reminders: how they ended.
  if (rem.sent > 0) {
    if (rem.completed === rem.sent) {
      out.push(rem.sent === 1 ? 'The one reminder was finished.' : `All ${rem.sent} reminders were finished.`)
    } else {
      const parts = [`${rem.completed} of ${rem.sent} reminders ${rem.completed === 1 ? 'was' : 'were'} finished`]
      if (rem.ignored > 0) parts.push(`${rem.ignored} ${rem.ignored === 1 ? 'was' : 'were'} ignored`)
      if (rem.open > 0) {
        parts.push(`${rem.open} ${rem.open === 1 ? 'was' : 'were'} ${r.day_complete ? 'left unfinished' : 'still in progress'}`)
      }
      out.push(joinClauses(parts) + '.')
    }
  }
  if (rem.missed > 0) {
    out.push(`${plural(rem.missed, 'scheduled reminder')} didn't go off; the coaster may have been offline or unplugged.`)
  }
  if (rem.unscheduled > 0) {
    out.push(`${plural(rem.unscheduled, 'extra reminder was', 'extra reminders were')} sent from the app.`)
  }

  // How quickly drinking started, and how long finishing took.
  if (r.first_sip_median_min !== null) {
    const m = r.first_sip_median_min
    out.push(`After a reminder, the first sip usually came ${m < 1 ? 'in under a minute' : `within ${minutes(m)}`}.`)
  }
  if (r.complete_median_min !== null && rem.completed > 0) {
    out.push(`Finishing a reminder's amount took ${minutes(r.complete_median_min)}.`)
  }

  // Time of day.
  const active = r.periods.filter((p) => p.sent > 0 || p.planned_ml > 0)
  if (active.length > 1 && r.total_ml > 0) {
    const best = [...active].sort((a, b) => b.drank_ml - a.drank_ml)[0]
    out.push(`Most water was drunk in the ${best.name} (${volume(best.drank_ml)}).`)

    // The weakest part of the day, measured against its own plan.
    const planned = active.filter((p) => p.planned_ml > 0)
    if (planned.length > 1) {
      const worst = [...planned].sort(
        (a, b) => a.drank_ml / a.planned_ml - b.drank_ml / b.planned_ml)[0]
      if (worst !== best && worst.drank_ml < worst.planned_ml * 0.5) {
        out.push(`The ${worst.name} fell furthest behind: ${volume(worst.drank_ml)} of ${volume(worst.planned_ml)} planned.`)
      }
    }
  }
  if (rem.ignored > 1) {
    const withIgnored = r.periods.filter((p) => p.ignored > 0)
    if (withIgnored.length === 1) {
      out.push(`Every ignored reminder was in the ${withIgnored[0].name}.`)
    }
  }

  // Sips.
  if (r.sips.count === 1 && r.sips.average_ml !== null) {
    out.push(`1 sip, of about ${volume(r.sips.average_ml)}.`)
  } else if (r.sips.count > 1 && r.sips.average_ml !== null) {
    const largest = r.sips.largest_ml !== null ? `; the largest was ${volume(r.sips.largest_ml)}` : ''
    out.push(`${r.sips.count} sips of about ${volume(r.sips.average_ml)} each${largest}.`)
  }

  // Compared with the previous week.
  if (r.week.days > 0 && r.week.average_ml !== null) {
    const diff = r.total_ml - r.week.average_ml
    const span = `the previous ${plural(r.week.days, 'day')} with reminders`
    if (Math.abs(diff) < 50) {
      out.push(`About the same as ${span} (average ${volume(r.week.average_ml)}).`)
    } else {
      out.push(`${volume(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${span} (average ${volume(r.week.average_ml)}).`)
    }
    if (r.goal_ml > 0) {
      out.push(`The daily goal was reached on ${r.week.goal_met_days} of those ${plural(r.week.days, 'day')}.`)
    }
  }

  return out
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

export const OUTCOME_TEXT: Record<Outcome, string> = {
  completed: 'Finished',
  ignored: 'Ignored',
  open: 'Unfinished',
}

/** "16:23" -> "4:23 PM". */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
