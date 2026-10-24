// Geometry of the day strip: the alternation rule, and labels never colliding.
// Pure logic, no database.

import { layout, labelBox, xFor, W, PAD, AXIS_Y, OFFSET, LABEL_W } from '../src/lib/daychart.ts'
import { createSuite, runIfMain } from './helpers.mjs'

const at = (h, m = 0) => ({ minutes: h * 60 + m })

export async function run() {
  const { check, results } = createSuite('daychart')
  console.log('\n--- daychart ---')

  // The alternation rule, as asked for: first mark above, then alternating.
  {
    const p = layout([at(8), at(10), at(12), at(14), at(16)])
    check('starts above the line', p[0].above === true)
    check('alternates after that',
      JSON.stringify(p.map((x) => x.above)) === JSON.stringify([true, false, true, false, true]))
    check('above marks sit above the line', p[0].cy === AXIS_Y - OFFSET)
    check('below marks sit below the line', p[1].cy === AXIS_Y + OFFSET)
  }

  // Alternation follows time order, not the order they happen to arrive in.
  {
    const p = layout([at(16), at(8), at(12)])
    check('sorted by time', JSON.stringify(p.map((x) => x.mark.minutes)) ===
      JSON.stringify([480, 720, 960]))
    check('earliest is the one above', p[0].mark.minutes === 480 && p[0].above === true)
  }

  // Position maps the full day onto the plot area.
  {
    check('midnight sits at the left edge', xFor(0) === PAD)
    check('end of day sits at the right edge', Math.round(xFor(1440)) === W - PAD)
    check('noon sits in the middle', Math.round(xFor(720)) === Math.round(W / 2))
  }

  // No two drawn labels on the same side may overlap.
  {
    // Eight reminders an hour apart: tight enough to force some labels out.
    const marks = Array.from({ length: 8 }, (_, i) => at(9 + i))
    const p = layout(marks)
    check('crowded strip drops some labels', p.some((x) => !x.label))
    check('every mark is still drawn', p.length === 8)
    check('no two shown labels on a side are closer than the label width',
      noLabelOverlap(p), describeOverlap(p))
  }

  // A comfortable spread keeps every label.
  {
    const p = layout([at(8), at(11), at(14), at(17), at(20)])
    check('roomy strip keeps every label', p.every((x) => x.label))
    check('no overlap in the roomy case', noLabelOverlap(p))
  }

  // Degenerate inputs shouldn't throw or produce NaN.
  {
    check('empty input is fine', layout([]).length === 0)
    const one = layout([at(9)])
    check('single mark goes above', one[0].above === true && one[0].label === true)
    const edges = layout([at(0), at(23, 59)])
    check('edge times stay inside the plot',
      edges.every((e) => e.cx >= PAD - 0.01 && e.cx <= W - PAD + 0.01))
  }

  // Labels at the ends must not spill outside the viewBox and get clipped.
  {
    const p = layout([at(0), at(23, 59)])
    check('first label anchors to the left edge', p[0].anchor === 'start')
    check('last label anchors to the right edge', p[1].anchor === 'end')
    check('no label crosses the left edge',
      p.every((m) => labelBox(m)[0] >= 0), String(labelBox(p[0])[0]))
    check('no label crosses the right edge',
      p.every((m) => labelBox(m)[1] <= W), String(labelBox(p[1])[1]))
  }

  // A mark in the middle keeps its label centred on it.
  {
    const [p] = layout([at(12)])
    check('middle label stays centred', p.anchor === 'middle' && p.textX === p.cx)
  }

  return results()
}

function sameSidePairs(placed) {
  const shown = placed.filter((p) => p.label)
  const pairs = []
  for (const side of [true, false]) {
    const row = shown.filter((p) => p.above === side)
    for (let i = 1; i < row.length; i++) pairs.push([row[i - 1], row[i]])
  }
  return pairs
}

// Compares the actual text boxes, so an edge-anchored label is judged where it
// really sits rather than where its mark is.
const noLabelOverlap = (placed) =>
  sameSidePairs(placed).every(([a, b]) => labelBox(b)[0] >= labelBox(a)[1])

const describeOverlap = (placed) => {
  const bad = sameSidePairs(placed).find(([a, b]) => labelBox(b)[0] < labelBox(a)[1])
  return bad ? `overlap of ${Math.round(labelBox(bad[0])[1] - labelBox(bad[1])[0])}` : ''
}

runIfMain(import.meta.url, run)
