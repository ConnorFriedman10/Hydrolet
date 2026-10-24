import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Profile } from './types'

// ---------------------------------------------------------------------------
// Auth: the signed-in user's session
// ---------------------------------------------------------------------------

type AuthState = { session: Session | null; loading: boolean }
const AuthCtx = createContext<AuthState>({ session: null, loading: true })
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  return <AuthCtx.Provider value={{ session, loading }}>{children}</AuthCtx.Provider>
}

// ---------------------------------------------------------------------------
// Subject: which account am I currently viewing?
// (myself, or one of the accounts I take care of)
// ---------------------------------------------------------------------------

type SubjectState = {
  subjects: Profile[]        // me first, then accounts I care for
  subject: Profile | null    // the one selected in the switcher
  me: Profile | null         // my own profile
  loading: boolean
  select: (id: string) => void
  reload: () => Promise<void>
}

const SubjectCtx = createContext<SubjectState>({
  subjects: [], subject: null, me: null, loading: true,
  select: () => {}, reload: async () => {},
})
export const useSubject = () => useContext(SubjectCtx)

const STORE_KEY = 'hydrolet.subject'

function readStored(): string | null {
  try { return localStorage.getItem(STORE_KEY) } catch { return null }
}
function writeStored(id: string | null) {
  try {
    if (id) localStorage.setItem(STORE_KEY, id)
    else localStorage.removeItem(STORE_KEY)
  } catch { /* private mode, ignore */ }
}

export function SubjectProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [subjects, setSubjects] = useState<Profile[]>([])
  const [selected, setSelected] = useState<string | null>(() => readStored())
  const [loading, setLoading] = useState(true)

  const uid = session?.user.id

  const reload = useCallback(async () => {
    if (!supabase || !uid) {
      setSubjects([])
      return
    }
    // My own profile first, so I know who I care for.
    const { data: meRow } = await supabase.from('profiles').select('*').eq('id', uid).single()
    const me = meRow as Profile | null
    const ids = [uid, ...(me?.caretaker_of ?? [])]
    const { data } = await supabase.from('profiles').select('*').in('id', ids)
    const list = (data ?? []) as Profile[]
    // Keep "me" at the front; everyone else alphabetical by name.
    list.sort((a, b) =>
      a.id === uid ? -1 : b.id === uid ? 1 : (a.name || '').localeCompare(b.name || ''),
    )
    setSubjects(list)
  }, [uid])

  // Reload whenever the signed-in user changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    reload().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  // Clear the remembered subject on sign-out.
  useEffect(() => {
    if (!uid) {
      setSelected(null)
      writeStored(null)
    }
  }, [uid])

  const me = subjects.find((p) => p.id === uid) ?? null
  // Fall back to "me" if the stored selection is no longer available.
  const subject = subjects.find((p) => p.id === selected) ?? me

  const select = (id: string) => {
    setSelected(id)
    writeStored(id)
  }

  return (
    <SubjectCtx.Provider value={{ subjects, subject, me, loading, select, reload }}>
      {children}
    </SubjectCtx.Provider>
  )
}
