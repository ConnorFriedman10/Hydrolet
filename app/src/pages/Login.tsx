import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import Drop from '../components/Drop'

export default function Login() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setMsg('')

    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMsg(friendly(error.message))
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } },
      })
      if (error) setMsg(friendly(error.message))
      else if (!data.session) setMsg('Check your email to confirm your account, then log in.')
      // With email confirmation off, a session is returned and AuthProvider takes over.
    }
    setBusy(false)
  }

  return (
    <div className="login">
      <div className="brand">
        <Drop size={64} />
        <h1>Hydrolet</h1>
      </div>
      <p className="muted">Hydration reminders for the people you love.</p>

      <form onSubmit={submit} className="card">
        {mode === 'signup' && (
          <label>Name
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          </label>
        )}
        <label>Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            required autoComplete="email" />
        </label>
        <label>Password
          <input type="password" minLength={6} value={password}
            onChange={(e) => setPassword(e.target.value)} required
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        <button disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
        {msg && <p className="error">{msg}</p>}
      </form>

      <button className="link" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMsg('') }}>
        {mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'}
      </button>
    </div>
  )
}

function friendly(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Wrong email or password.'
  if (/already registered/i.test(message)) return 'That email already has an account. Try logging in.'
  return message
}
