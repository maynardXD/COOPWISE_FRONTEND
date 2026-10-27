import { useEffect, useState } from 'react'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost/LavaLust-COOPWISE/api').replace(/\/+$/, '')
const TODAY = new Date().toISOString().slice(0, 10)
const LOAN_ENDPOINTS = ['/loan-products', '/loans', '/payments']
const COOPERATIVE_ENDPOINTS = ['/cooperative/cycles']

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

function usePortalData(token, refreshKey, endpoints) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.all(endpoints.map((path) => apiRequest(path, { token })))
      .then((results) => {
        if (active) {
          setData(results)
          setError('')
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
    return () => { active = false }
  }, [token, refreshKey, endpoints])

  return { data, error }
}

function PortalMessage({ children, error = false }) {
  return children ? <div className={error ? 'message message-error' : 'message'} role="status">{children}</div> : null
}

function LoanPortal({ token, user, refreshKey }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error } = usePortalData(token, refreshKey, LOAN_ENDPOINTS)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [schedule, setSchedule] = useState(null)
  const products = data?.[0]?.products || []
  const loans = data?.[1]?.loans || []
  const payments = data?.[2]?.payments || []

  async function submit(event, path, method = 'POST', successMessage = 'Changes saved.') {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    setNotice('')
    setActionError('')
    try {
      await apiRequest(path, { token, method, body: JSON.stringify(values) })
      setNotice(successMessage)
      form.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function reviewLoan(loanId, decision) {
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest(`/loans/${loanId}/review`, {
        token, method: 'POST', body: JSON.stringify({ decision }),
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function showSchedule(loanId) {
    setActionError('')
    try {
      setSchedule(await apiRequest(`/loans/${loanId}/schedule`, { token }))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return (
    <section className="portal-section">
      <h2>Monthly loans</h2>
      <p className="muted">Apply for a loan, review applications, and record payments. Interest and limits follow the product configured by staff.</p>
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>

      {staff ? (
        <details className="portal-card">
          <summary>Create loan product</summary>
          <form className="form-grid" onSubmit={(event) => submit(event, '/loan-products', 'POST', 'Loan product created.')}>
            <label>Product name<input name="name" required maxLength="100" /></label>
            <label>Monthly interest rate (%)<input name="interest_rate" type="number" min="0" max="99.99" step="0.01" required /></label>
            <label>Maximum amount (PHP)<input name="max_amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Maximum term (months)<input name="max_term_months" type="number" min="1" max="120" required /></label>
            <label className="full">Description<input name="description" maxLength="255" /></label>
            <button className="button button-primary" type="submit">Create product</button>
          </form>
        </details>
      ) : (
        <details className="portal-card">
          <summary>Apply for a loan</summary>
          <form className="form-grid" onSubmit={(event) => submit(event, '/loans', 'POST', 'Loan application submitted.')}>
            <label className="full">Loan product
              <select name="loan_type_id" required defaultValue="">
                <option value="" disabled>Select a product</option>
                {products.map((product) => <option key={product.id} value={product.id}>{product.name} · {product.interest_rate}% monthly · max PHP {product.max_amount}</option>)}
              </select>
            </label>
            <label>Amount (PHP)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Term (months)<input name="term_months" type="number" min="1" required /></label>
            <label className="full">Purpose<input name="purpose" maxLength="255" /></label>
            <button className="button button-primary" type="submit" disabled={!products.length}>Submit application</button>
          </form>
        </details>
      )}

      <h3>{staff ? 'Applications and active loans' : 'Your loans'}</h3>
      {data && loans.length === 0 && <p className="muted">No loan applications yet.</p>}
      {loans.map((loan) => (
        <article className="portal-card" key={loan.id}>
          <div className="item-heading">
            <div><strong>{loan.loan_type_name}</strong><span>{loan.loan_code} · {loan.member_number || user.member?.member_number || 'Member'}</span></div>
            <span className={`status status-${loan.status}`}>{loan.status}</span>
          </div>
          <p>Requested PHP {loan.principal_amount} · {loan.term_months} months · {loan.interest_rate}% monthly</p>
          {loan.status !== 'pending' && <p>Balance: PHP {loan.current_balance} · Paid: PHP {loan.total_paid}</p>}
          {loan.purpose && <p className="muted">Purpose: {loan.purpose}</p>}
          <div className="button-row">
            {loan.status === 'approved' || loan.status === 'active'
              ? <button className="button button-outline" type="button" onClick={() => showSchedule(loan.id)}>View schedule</button>
              : null}
            {staff && loan.status === 'pending' && <>
              <button className="button button-primary" type="button" onClick={() => reviewLoan(loan.id, 'approve')}>Approve</button>
              <button className="button button-outline" type="button" onClick={() => reviewLoan(loan.id, 'reject')}>Reject</button>
            </>}
            {staff && ['approved', 'active'].includes(loan.status) && (
              <form className="inline-form" onSubmit={(event) => submit(event, `/loans/${loan.id}/payments`, 'POST', 'Payment recorded.')}>
                <input name="amount" type="number" min="0.01" step="0.01" placeholder="Payment amount" required />
                <select name="method" defaultValue="cash" aria-label="Payment method">
                  <option value="cash">Cash</option><option value="bank">Bank</option><option value="gcash">GCash</option><option value="check">Check</option>
                </select>
                <button className="button button-primary" type="submit">Record payment</button>
              </form>
            )}
          </div>
        </article>
      ))}
      {schedule && (
        <div className="portal-card">
          <div className="item-heading"><strong>{schedule.loan.loan_code} repayment schedule</strong><button className="button button-outline" type="button" onClick={() => setSchedule(null)}>Close</button></div>
          <div className="table-wrap"><table><thead><tr><th>Due date</th><th>Due</th><th>Paid</th><th>Status</th></tr></thead>
            <tbody>{schedule.schedule.map((item) => <tr key={item.id}><td>{item.due_date}</td><td>PHP {item.total_due}</td><td>PHP {item.paid_amount}</td><td>{item.status}</td></tr>)}</tbody>
          </table></div>
        </div>
      )}
      {staff && <details className="portal-card"><summary>Recent payments</summary>
        {payments.length ? <div className="table-wrap"><table><thead><tr><th>Loan</th><th>Member</th><th>Amount</th><th>Method</th><th>Date</th></tr></thead>
          <tbody>{payments.map((payment) => <tr key={payment.id}><td>{payment.loan_code}</td><td>{payment.first_name} {payment.last_name}</td><td>PHP {payment.amount_paid}</td><td>{payment.payment_method}</td><td>{payment.payment_date}</td></tr>)}</tbody>
        </table></div> : <p className="muted">No payments recorded.</p>}
      </details>}
    </section>
  )
}

function CooperativePortal({ token, user, refreshKey }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error } = usePortalData(token, refreshKey, COOPERATIVE_ENDPOINTS)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const cyclesData = data?.[0]
  const cycles = cyclesData?.cycles || []
  const members = cyclesData?.members || []

  async function submit(event, path, successMessage) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest(path, { token, method: 'POST', body: JSON.stringify(values) })
      setNotice(result.message || successMessage)
      form.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function changeCycle(path, values, successMessage, method = 'POST') {
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest(path, { token, method, body: JSON.stringify(values) })
      setNotice(result.message || successMessage)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return (
    <section className="portal-section">
      <h2>Daily rotating savings (Paluwagan)</h2>
      <p className="muted">Members contribute the set amount each day. When everyone has contributed, the next person in the agreed payout order is ready to receive the pooled amount; staff confirms when the payout is made.</p>
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>

      {staff && <>
        <details className="portal-card">
          <summary>Create daily cycle</summary>
          <form className="form-grid" onSubmit={(event) => submit(event, '/cooperative/cycles', 'Draft cycle created.')}>
            <label>Cycle name<input name="name" required maxLength="120" /></label>
            <label>Daily contribution (PHP)<input name="daily_contribution" type="number" min="0.01" step="0.01" required /></label>
            <label>Start date<input name="start_date" type="date" min={TODAY} defaultValue={TODAY} required /></label>
            <button className="button button-primary" type="submit">Create draft</button>
          </form>
        </details>
        {cycles.some((cycle) => cycle.status === 'draft') && (
          <details className="portal-card">
            <summary>Enroll members and set payout order</summary>
            <form className="form-grid" onSubmit={(event) => submit(event, '/cooperative/cycles/members', 'Member added to the draft cycle.')}>
              <label>Draft cycle<select name="cycle_id" required defaultValue="">
                <option value="">Select a cycle</option>
                {cycles.filter((cycle) => cycle.status === 'draft').map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}
              </select></label>
              <label>Member<select name="member_id" required defaultValue="">
                <option value="">Select a member</option>
                {members.map((member) => <option key={member.id} value={member.id}>{member.member_number} · {member.first_name} {member.last_name}</option>)}
              </select></label>
              <label>Payout order<input name="payout_order" type="number" min="1" required /></label>
              <button className="button button-primary" type="submit">Add member</button>
            </form>
          </details>
        )}
      </>}

      {data && cycles.length === 0 && <p className="muted">No daily cycles are available.</p>}
      {cycles.map((cycle) => (
        <article className="portal-card" key={cycle.id}>
          <div className="item-heading">
            <div><strong>{cycle.name}</strong><span>PHP {cycle.daily_contribution} daily · Starts {cycle.start_date}</span></div>
            <span className={`status status-${cycle.status}`}>{cycle.status}</span>
          </div>
          <p>{cycle.today_contributions} of {cycle.member_count} contributions recorded today.</p>
          {staff && cycle.status === 'draft' && (
            <button className="button button-primary" type="button" onClick={() => changeCycle('/cooperative/cycles/activate', { cycle_id: cycle.id }, 'Cycle activated.')}>Activate cycle</button>
          )}
          {staff && cycle.status === 'active' && (
            <form className="inline-form" onSubmit={(event) => submit(event, '/cooperative/contributions', 'Contribution recorded.')}>
              <input type="hidden" name="cycle_id" value={cycle.id} />
              <select name="member_id" required defaultValue=""><option value="" disabled>Member contribution</option>
                {cycle.members.map((member) => <option key={member.member_id} value={member.member_id}>{member.member_number} · {member.first_name} {member.last_name}</option>)}
              </select>
              <button className="button button-primary" type="submit">Record today’s contribution</button>
            </form>
          )}
          {cycle.ready_payout && (
            <div className="payout-callout">
              <strong>Pooled payout ready: PHP {cycle.ready_payout.amount}</strong>
              <span>Recipient: {cycle.ready_payout.first_name} {cycle.ready_payout.last_name} (order {cycle.ready_payout.payout_order})</span>
              {staff && <button className="button button-primary" type="button" onClick={() => changeCycle('/cooperative/payouts/mark-paid', { payout_id: cycle.ready_payout.id }, 'Payout marked paid.')}>Confirm payout paid</button>}
            </div>
          )}
          <h3>Agreed payout order</h3>
          <ol className="member-order">{cycle.members.map((member) => <li key={member.member_id}>
            {member.first_name} {member.last_name} · #{member.payout_order}
            {member.payout_status && <span className="muted"> — {member.payout_status}</span>}
            {staff && cycle.status === 'draft' && <button className="text-button" type="button" onClick={() => changeCycle('/cooperative/cycles/members', { cycle_id: cycle.id, member_id: member.member_id }, 'Member removed.', 'DELETE')}>Remove</button>}
          </li>)}</ol>
          {cycle.my_contributed_today && <p className="notice">Your contribution for today has been recorded.</p>}
        </article>
      ))}
      {cyclesData && <>
        <h3>Contribution history</h3>
        {cyclesData.contributions.length ? <div className="table-wrap"><table><thead><tr><th>Cycle</th><th>Member</th><th>Date</th><th>Amount</th></tr></thead>
          <tbody>{cyclesData.contributions.map((item) => <tr key={item.id}><td>{item.cycle_name}</td><td>{item.first_name} {item.last_name}</td><td>{item.contribution_date}</td><td>PHP {item.amount}</td></tr>)}</tbody>
        </table></div> : <p className="muted">No contributions recorded.</p>}
        <h3>Payout history</h3>
        {cyclesData.payouts.length ? <div className="table-wrap"><table><thead><tr><th>Cycle</th><th>Recipient</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>{cyclesData.payouts.map((item) => <tr key={item.id}><td>{item.cycle_name}</td><td>{item.first_name} {item.last_name}</td><td>{item.payout_date}</td><td>PHP {item.amount}</td><td>{item.status}</td></tr>)}</tbody>
        </table></div> : <p className="muted">No payouts are recorded.</p>}
      </>}
    </section>
  )
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('coopwise_access_token'))
  const [user, setUser] = useState(null)
  const [mode, setMode] = useState('login')
  const [section, setSection] = useState('loans')
  const [message, setMessage] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

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

  useEffect(() => {
    const refresh = () => setRefreshKey((key) => key + 1)
    window.addEventListener('coopwise:refresh', refresh)
    return () => window.removeEventListener('coopwise:refresh', refresh)
  }, [])

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    setFieldErrors({})
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    try {
      if (mode === 'register') {
        await apiRequest('/auth/register', { method: 'POST', body: JSON.stringify(values) })
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
    } catch (requestError) {
      setMessage(requestError.message)
      setFieldErrors(requestError.fields || {})
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
          <nav className="portal-tabs" aria-label="Cooperative services">
            <button className={section === 'loans' ? 'tab active' : 'tab'} type="button" onClick={() => setSection('loans')}>Monthly loans</button>
            <button className={section === 'cooperative' ? 'tab active' : 'tab'} type="button" onClick={() => setSection('cooperative')}>Daily Paluwagan</button>
          </nav>
          {section === 'loans'
            ? <LoanPortal key="loans" token={token} user={user} refreshKey={refreshKey} />
            : <CooperativePortal key="cooperative" token={token} user={user} refreshKey={refreshKey} />}
          <button className="button button-outline sign-out" onClick={signOut} type="button">Sign out</button>
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
