import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { disablePush, enablePush, getPushState, sendPush, type PushState } from '../lib/push'

// "Enable notifications" for this device: the daily summary, and an alert
// only when drinking falls well behind.
export default function NotificationsCard() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    getPushState().then(setState).catch(() => setState('off'))
  }, [])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg('')
    try { await fn() } catch (err) { setMsg(err instanceof Error ? err.message : String(err)) }
    setBusy(false)
  }

  const enable = () => run(async () => {
    const next = await enablePush()
    setState(next)
    if (next === 'on') {
      // Confirms the whole path, not just the permission.
      const r = await sendPush({ kind: 'test' })
      setMsg(r.sent > 0 ? 'On. A test notification is on its way.' : 'On, but the test could not be delivered.')
    }
  })

  const test = () => run(async () => {
    const r = await sendPush({ kind: 'test' })
    setMsg(r.sent > 0
      ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}.`
      : 'Nothing was delivered. Try turning notifications off and on again.')
  })

  const disable = () => run(async () => {
    await disablePush()
    setState('off')
    setMsg('Notifications are off on this device.')
  })

  return (
    <section className="card">
      <h2>Notifications</h2>
      <p className="muted small">
        A summary each evening, and an alert only if drinking falls well behind.
      </p>

      {state === null && <p className="muted small">Checking…</p>}

      {state === 'needs-install' && (
        <p className="small">
          On iPhone, add Hydrolet to your home screen first, then open it from there.{' '}
          <Link to="/install">How to install</Link>
        </p>
      )}

      {state === 'unsupported' && (
        <p className="small">This browser can't receive notifications. Try Chrome, Edge, Firefox or Safari.</p>
      )}

      {state === 'denied' && (
        <p className="small">
          Notifications are blocked for Hydrolet. Allow them in your browser or phone settings, then reload.
        </p>
      )}

      {state === 'off' && (
        <button onClick={enable} disabled={busy}>Enable notifications</button>
      )}

      {state === 'on' && (
        <>
          <p className="small"><span className="dot on" aria-hidden="true" />On for this device.</p>
          <div className="row">
            <button className="secondary" onClick={test} disabled={busy}>Send a test</button>
            <button className="secondary" onClick={disable} disabled={busy}>Turn off</button>
          </div>
        </>
      )}

      {msg && <p className="muted small" role="status">{msg}</p>}
    </section>
  )
}
