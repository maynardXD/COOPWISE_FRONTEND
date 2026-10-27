import { useEffect, useState } from 'react'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost/LavaLust-COOPWISE/api').replace(/\/+$/, '')
const TODAY = new Date().toISOString().slice(0, 10)

async function apiRequest(path, { token, ...options } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.message || body.error || 'The request could not be completed.')
    error.fields = body.errors || {}
    throw error
  }
  return body
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('coopwise_access_token'))
  const [user, setUser] = useState(null)
  const [mode, setMode] = useState('login')
  const [message, setMessage] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) return
    apiRequest('/me', { token })
      .then((result) => setUser(result.user))
      .catch(() => {
        sessionStorage.removeItem('coopwise_access_token')
        setToken(null)
        setUser(null)
      })
  }, [token])

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    setFieldErrors({})
    const formData = new FormData(event.currentTarget)
    const values = Object.fromEntries(formData.entries())
    try {
      if (mode === 'register') {
        await apiRequest('/auth/register', {
          method: 'POST',
          body: JSON.stringify(values),
        })
        setMode('login')
        setMessage('Registration complete. Sign in with your email or phone number.')
      } else {
        const result = await apiRequest('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ login: values.login, password: values.password }),
        })
        sessionStorage.setItem('coopwise_access_token', result.access_token)
        setToken(result.access_token)
        setUser(result.user)
      }
    } catch (error) {
      setMessage(error.message)
      setFieldErrors(error.fields || {})
    } finally {
      setBusy(false)
    }
  }

  function signOut() {
    sessionStorage.removeItem('coopwise_access_token')
    setToken(null)
    setUser(null)
    setMode('login')
    setMessage('You have signed out.')
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CoopWise home">Coop<span>Wise</span></a>
        <span className="tagline">Cooperative services, made clear</span>
      </header>

      {user ? (
        <section className="dashboard card">
          <div className="eyebrow">Member portal</div>
          <h1>Welcome, {user.full_name}</h1>
          <p className="muted">Signed in as {user.role}.</p>
          <div className="profile-card">
            <div><span>Account</span><strong>{user.full_name}</strong></div>
            <div><span>Role</span><strong>{user.role}</strong></div>
            {user.member && <div><span>Member number</span><strong>{user.member.member_number}</strong></div>}
          </div>
          <div className="notice">
            This separate frontend is connected to the LavaLust API. Loan, savings, payment, and daily-cycle screens still need their API endpoints and frontend integration before they can be managed here.
          </div>
          <button className="button button-outline" onClick={signOut} type="button">Sign out</button>
        </section>
      ) : (
        <section className="auth-layout">
          <div className="intro">
            <div className="eyebrow">CoopWise member system</div>
            <h1>One place for your cooperative journey.</h1>
            <p>Sign in to your account or register as a member. Your account is managed securely by the CoopWise LavaLust backend.</p>
            <div className="feature-note"><span className="feature-dot" /> Separate React frontend · LavaLust API backend</div>
          </div>

          <div className="card auth-card">
            <div className="tabs" role="tablist" aria-label="Account options">
              <button className={mode === 'login' ? 'tab active' : 'tab'} type="button" onClick={() => { setMode('login'); setMessage(''); setFieldErrors({}) }}>Sign in</button>
              <button className={mode === 'register' ? 'tab active' : 'tab'} type="button" onClick={() => { setMode('register'); setMessage(''); setFieldErrors({}) }}>Register</button>
            </div>
            <h2>{mode === 'login' ? 'Welcome back' : 'Create your member account'}</h2>
            {message && <div className="message" role="status">{message}</div>}
            <form onSubmit={handleSubmit}>
              {mode === 'register' ? (
                <div className="form-grid">
                  <label>First name<input name="first_name" autoComplete="given-name" required maxLength="100" />{fieldErrors.first_name && <small>{fieldErrors.first_name}</small>}</label>
                  <label>Middle name <span className="optional">(optional)</span><input name="middle_name" autoComplete="additional-name" maxLength="100" />{fieldErrors.middle_name && <small>{fieldErrors.middle_name}</small>}</label>
                  <label>Last name<input name="last_name" autoComplete="family-name" required maxLength="100" />{fieldErrors.last_name && <small>{fieldErrors.last_name}</small>}</label>
                  <label>Phone number<input name="phone_number" autoComplete="tel" inputMode="numeric" placeholder="09123456789" required pattern="09[0-9]{9}" maxLength="11" />{fieldErrors.phone_number && <small>{fieldErrors.phone_number}</small>}</label>
                  <label className="full">Email address<input name="email" type="email" autoComplete="email" required maxLength="254" />{fieldErrors.email && <small>{fieldErrors.email}</small>}</label>
                  <label>Date of birth<input name="date_of_birth" type="date" autoComplete="bday" required max={TODAY} />{fieldErrors.date_of_birth && <small>{fieldErrors.date_of_birth}</small>}</label>
                  <label>Password<input name="password" type="password" autoComplete="new-password" required minLength="8" maxLength="128" />{fieldErrors.password && <small>{fieldErrors.password}</small>}</label>
                  <label className="full">Confirm password<input name="password_confirmation" type="password" autoComplete="new-password" required minLength="8" maxLength="128" />{fieldErrors.password_confirmation && <small>{fieldErrors.password_confirmation}</small>}</label>
                </div>
              ) : (
                <>
                  <label>Email or phone number<input name="login" autoComplete="username" required placeholder="Email address or 09123456789" /></label>
                  <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
                </>
              )}
              <button className="button button-primary submit" type="submit" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
            </form>
            {mode === 'register' && <p className="form-help">Names use letters and spaces. Use an 11-digit number starting with 09. Passwords require 8+ characters, one uppercase letter, one number, one special character, and no spaces.</p>}
          </div>
        </section>
      )}
      <footer>CoopWise demo · This system records cooperative activity; it does not transfer money.</footer>
    </main>
  )
}

export default App
