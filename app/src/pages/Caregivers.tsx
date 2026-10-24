import { useCallback, useEffect, useState } from 'react'
import { useSubject } from '../lib/auth'
import { supabase } from '../lib/supabase'

type Caregiver = { id: string; name: string }

export default function Caregivers() {
  const { me, subjects, reload } = useSubject()
  const [caregivers, setCaregivers] = useState<Caregiver[]>([])
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // Accounts that list me in their caretaker_of (the people who care for me).
  const loadCaregivers = useCallback(async () => {
    if (!supabase || !me) return
    const { data } = await supabase
      .from('profiles')
      .select('id, name')
      .contains('caretaker_of', [me.id])
    setCaregivers((data ?? []) as Caregiver[])
  }, [me?.id])

  useEffect(() => { loadCaregivers() }, [loadCaregivers])

  if (!me) return <p className="muted">Loading…</p>

  const caringFor = subjects.filter((p) => p.id !== me.id)

  const redeem = async () => {
    if (!supabase) return
    setBusy(true); setMsg('')
    const { error } = await supabase.rpc('redeem_caregiver_code', { p_code: code })
    if (error) {
      setMsg(/invalid caregiver code/i.test(error.message)
        ? "That code isn't valid. Check it and try again."
        : error.message)
    } else {
      setCode('')
      setMsg('Added. You can switch to that account from the menu at the top.')
      await reload()
    }
    setBusy(false)
  }

  const regenerate = async () => {
    if (!supabase) return
    if (!confirm('Anyone with the old code will no longer be able to join. Continue?')) return
    const { error } = await supabase.rpc('regenerate_caregiver_code')
    setMsg(error ? error.message : 'New code created.')
    if (!error) await reload()
  }

  const removeCaregiver = async (id: string) => {
    if (!supabase) return
    const { error } = await supabase.rpc('remove_caregiver', { p_caregiver: id })
    if (error) setMsg(error.message)
    else await loadCaregivers()
  }

  const stopCaring = async (id: string) => {
    if (!supabase) return
    const { error } = await supabase.rpc('stop_caring_for', { p_main: id })
    if (error) setMsg(error.message)
    else await reload()
  }

  return (
    <>
      <section className="card">
        <h2>Your caregiver code</h2>
        <div className="big code">{me.caregiver_code}</div>
        <p className="muted small">
          Family enter this code to see your dashboard and daily summary.
        </p>
        <button className="secondary" onClick={regenerate}>Make a new code</button>
      </section>

      <section className="card">
        <h2>Care for someone else</h2>
        <label>Their caregiver code
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().trim())}
            maxLength={8} placeholder="8 characters" autoCapitalize="characters" />
        </label>
        <button onClick={redeem} disabled={busy || code.length < 8}>Add</button>
      </section>

      <section className="card">
        <h2>People you care for</h2>
        {caringFor.length === 0 && <p className="muted">No one yet. Enter a code above.</p>}
        <ul className="list">
          {caringFor.map((p) => (
            <li key={p.id}>
              <span>{p.name || 'Unnamed'}</span>
              <button className="link" onClick={() => stopCaring(p.id)}>Stop caring</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Your caregivers</h2>
        {caregivers.length === 0 && <p className="muted">No one yet.</p>}
        <ul className="list">
          {caregivers.map((c) => (
            <li key={c.id}>
              <span>{c.name || 'Unnamed'}</span>
              <button className="link" onClick={() => removeCaregiver(c.id)}>Remove</button>
            </li>
          ))}
        </ul>
      </section>

      {msg && <p className="muted small">{msg}</p>}
    </>
  )
}
