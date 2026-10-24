// Geometry for the day strip. Pure, so it can be tested without a browser.

export const W = 720
export const H = 130
export const PAD = 30
export const AXIS_Y = 66
export const OFFSET = 24        // marker distance from the line
const DAY = 24 * 60
const PLOT = W - PAD * 2

// Roughly the width of "12:30 PM" at the label font size. Two labels on the
// same side closer than this would collide, so the later one is dropped rather
// than drawn over its neighbour.
export const LABEL_W = 86
const GAP = 8                   // breathing room between two labels
const EDGE = 2                  // keep text inside the viewBox

export const xFor = (minutes: number) => PAD + (minutes / DAY) * PLOT

export type Placed<T> = {
  mark: T
  above: boolean
  cx: number
  cy: number
  textX: number
  textY: number
  anchor: 'start' | 'middle' | 'end'
  label: boolean   // false when there wasn't room
}

/**
 * Lays marks out along the day: earliest first, alternating above and below
 * the line, always starting above.
 *
 * A label near either end is anchored to that end instead of centred on its
 * mark, so it can't spill outside the viewBox and get clipped.
 */
export function layout<T extends { minutes: number }>(marks: T[]): Placed<T>[] {
  const sorted = [...marks].sort((a, b) => a.minutes - b.minutes)
  const half = LABEL_W / 2
  const lastRight = { above: -Infinity, below: -Infinity }

  return sorted.map((mark, i) => {
    const above = i % 2 === 0
    const cx = xFor(mark.minutes)

    let textX = cx
    let anchor: 'start' | 'middle' | 'end' = 'middle'
    if (cx - half < EDGE) { textX = EDGE; anchor = 'start' }
    else if (cx + half > W - EDGE) { textX = W - EDGE; anchor = 'end' }

    const left = anchor === 'start' ? textX : anchor === 'end' ? textX - LABEL_W : textX - half
    const right = left + LABEL_W

    const side = above ? 'above' : 'below'
    const room = left >= lastRight[side] + GAP
    if (room) lastRight[side] = right

    const cy = above ? AXIS_Y - OFFSET : AXIS_Y + OFFSET
    return {
      mark, above, cx, cy, textX, anchor,
      textY: above ? cy - 18 : cy + 28,
      label: room,
    }
  })
}

/** The horizontal span a mark's label occupies, for collision checks. */
export function labelBox<T>(p: Placed<T>): [number, number] {
  const left = p.anchor === 'start' ? p.textX
    : p.anchor === 'end' ? p.textX - LABEL_W
    : p.textX - LABEL_W / 2
  return [left, left + LABEL_W]
}
