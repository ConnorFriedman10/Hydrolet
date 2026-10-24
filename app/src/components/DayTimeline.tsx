import type { Status } from '../lib/timeline'
import { layout, AXIS_Y, W, H, PAD, xFor } from '../lib/daychart'

// A decorative strip showing how the day's reminders are spread out.
// Non-interactive on purpose: the list beneath it carries every value in text,
// so nothing here is the only way to read something.
//
// Marks alternate above and below the line, starting above, which is what lets
// each reminder keep its own time label without the labels colliding.

export type Mark = {
  key: string
  minutes: number      // since midnight
  label: string        // "9:00 AM"
  status?: Status      // omitted on the Schedule page: a plan has no outcome yet
}

// Quiet anchors for morning / midday / evening. They carry no text: every mark
// is already labelled with its own time, and a second row of times competing
// with those labels just reads as clutter.
const HOURS = [6, 12, 18]

export default function DayTimeline({ marks }: { marks: Mark[] }) {
  if (marks.length === 0) return null

  const placed = layout(marks)

  return (
    <svg
      className="daychart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Reminders through the day: ${placed.map((p) => p.mark.label).join(', ')}`}
    >
      {HOURS.map((h) => (
        <line key={h} x1={xFor(h * 60)} x2={xFor(h * 60)}
          y1={AXIS_Y - 5} y2={AXIS_Y + 5} className="dc-tick" />
      ))}

      {/* The day */}
      <line x1={PAD} x2={W - PAD} y1={AXIS_Y} y2={AXIS_Y} className="dc-axis" />

      {placed.map(({ mark, cx, cy, textX, textY, anchor, label }) => (
        <g key={mark.key} className={`dc-mark ${mark.status ?? 'planned'}`}>
          <line x1={cx} x2={cx} y1={AXIS_Y} y2={cy} className="dc-stem" />
          <Marker cx={cx} cy={cy} status={mark.status} />
          {label && (
            <text x={textX} y={textY} textAnchor={anchor} className="dc-label">{mark.label}</text>
          )}
        </g>
      ))}
    </svg>
  )
}

/**
 * Status is carried by shape as well as colour. Red and green sit at a
 * colourblind separation of 6.6, which is only legible when something other
 * than hue also tells them apart.
 */
function Marker({ cx, cy, status }: { cx: number; cy: number; status?: Status }) {
  switch (status) {
    case 'active':
      return (
        <>
          <circle cx={cx} cy={cy} r={11} className="dc-halo" />
          <circle cx={cx} cy={cy} r={6} className="dc-dot" />
        </>
      )
    case 'ignored':
      // A diamond, so it is not merely "the red one".
      return (
        <rect
          x={cx - 6} y={cy - 6} width={12} height={12} rx={1.5}
          transform={`rotate(45 ${cx} ${cy})`}
          className="dc-dot"
        />
      )
    case 'not-logged':
      return <circle cx={cx} cy={cy} r={6} className="dc-dot hollow" />
    case 'upcoming':
      return <circle cx={cx} cy={cy} r={5} className="dc-dot hollow" />
    default: // completed, or an unstyled plan on the Schedule page
      return <circle cx={cx} cy={cy} r={6} className="dc-dot" />
  }
}
