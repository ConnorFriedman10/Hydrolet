import type { ReactNode } from 'react'

// Stands in for a page until its design and logic land.
export default function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted">Not built yet. This page will hold:</p>
      <ul className="muted">{children}</ul>
    </section>
  )
}
