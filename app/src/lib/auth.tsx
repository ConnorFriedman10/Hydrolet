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
  subjects: Profile[]      // me first, then accounts I care for
  subject: Profile | null  // the one selected in the switcher
  me: Profile | null       // my own profile
  caregivers: Profile[]    // the people who care for me
  subjectId: string | null // the selected id, known before any network call
  loading: boolean
  select: (id: string) => void
  reload: () => Promise<void>
}

const SubjectCtx = createContext<SubjectState>({
  subjects: [], subject: null, me: null, caregivers: [], subjectId: null,
  loading: true, select: () => {}, reload: async () => {},
})
export const useSubject = () => useContext(SubjectCtx)

const STORE_KEY = 'hydrolet.subject'
const CACHE_KEY = 'hydrolet.profiles'

function readStored(): string | null {
  try { return localStorage.getItem(STORE_KEY) } catch { return null }
}
function writeStored(id: string | null) {
  try {
    if (id) localStorage.setItem(STORE_KEY, id)
    else localStorage.removeItem(STORE_KEY)
  } catch { /* private mode, ignore */ }
}

// Last known profiles, so a reload renders something before the network
// answers. Only ever a display shortcut: every page's data still comes from
// the server, where row-level security decides what is allowed.
function readCache(uid: string): Profile[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return []
    const { uid: cachedFor, rows } = JSON.parse(raw)
    return cachedFor === uid ? (rows as Profile[]) : []
  } catch { return [] }
}
function writeCache(uid: string, rows: Profile[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid, rows })) } catch { /* ignore */ }
}

export function SubjectProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const uid = session?.user.id ?? null

  const [rows, setRows] = useState<Profile[]>([])
  const [selected, setSelected] = useState<string | null>(() => readStored())
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!supabase || !uid) {
      setRows([])
      return
    }
    // No filter needed: the select policy already limits this to my own
    // profile, the people I care for, and the people who care for me. That is
    // every profile any page needs, in one trip instead of two.
    const { data } = await supabase.from('profiles').select('*')
    const list = (data ?? []) as Profile[]
    setRows(list)
    writeCache(uid, list)
  }, [uid])

  useEffect(() => {
    if (!uid) {
      setRows([])
      setSelected(null)
      writeStored(null)
      setLoading(false)
      return
    }
    setRows(readCache(uid))  // render immediately, then confirm with the server
    let cancelled = false
    setLoading(true)
    reload().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [uid, reload])

  const me = rows.find((p) => p.id === uid) ?? null
  const subjects = me
    ? [me, ...rows
        .filter((p) => p.id !== uid && (me.caretaker_of ?? []).includes(p.id))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))]
    : []
  const caregivers = uid
    ? rows.filter((p) => p.id !== uid && (p.caretaker_of ?? []).includes(uid))
    : []

  // Fall back to "me" if the remembered selection is no longer available.
  const subject = subjects.find((p) => p.id === selected) ?? me

  // Pages key their own queries off this. It is known from localStorage and
  // the session alone, so they can fetch alongside the profiles call rather
  // than waiting behind it. If the remembered id turns out to be stale, the
  // fallback above corrects it and the page refetches.
  const subjectId = subject?.id ?? selected ?? uid

  const select = (id: string) => {
    setSelected(id)
    writeStored(id)
  }

  return (
    <SubjectCtx.Provider
      value={{ subjects, subject, me, caregivers, subjectId, loading, select, reload }}
    >
      {children}
    </SubjectCtx.Provider>
  )
}
