import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost/COOPWISE/LavaLust-COOPWISE/api').replace(/\/+$/, '')
const TODAY = new Date().toISOString().slice(0, 10)
const LOAN_ENDPOINTS = ['/loan-products', '/loans', '/payments', '/loan-readiness']
const COOPERATIVE_ENDPOINTS = ['/cooperative/cycles']
const PAYMENT_ENDPOINTS = ['/loans', '/cooperative/cycles', '/payment-submissions']
const SAVINGS_ENDPOINTS = ['/savings']
const REPORT_ENDPOINTS = ['/reports']

async function apiRequest(path, { token, ...options } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.message || body.error || `Request failed (${response.status}).`)
    error.fields = body.errors || {}
    throw error
  }
  return body
}

async function openProtectedImage(token, path) {
  const preview = window.open('about:blank', '_blank')
  if (!preview) throw new Error('Allow pop-ups to view this private image.')
  try {
    const response = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || body.error || 'The image could not be opened.')
    }
    const objectUrl = URL.createObjectURL(await response.blob())
    preview.location.href = objectUrl
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000)
  } catch (error) {
    preview.close()
    throw error
  }
}

function usePortalData(token, refreshKey, endpoints) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    Promise.all(endpoints.map(async (path) => {
      try {
        return { result: await apiRequest(path, { token }) }
      } catch (requestError) {
        return { error: `${path}: ${requestError.message}` }
      }
    }))
      .then((results) => {
        if (active) {
          setData(results.map((item) => item.result || null))
          setError(results.filter((item) => item.error).map((item) => item.error).join(' · '))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [token, refreshKey, endpoints])

  return { data, error, loading }
}

function PortalMessage({ children, error = false }) {
  return children ? <div className={error ? 'message message-error' : 'message'} role="status">{children}</div> : null
}

function StaffEmptyState({ type, title, description, loading = false }) {
  return (
    <div className={`staff-empty-state${loading ? ' is-loading' : ''}`} role={loading ? 'status' : 'group'} aria-live={loading ? 'polite' : undefined}>
      <svg className={`staff-empty-art staff-empty-art-${type}`} viewBox="0 0 180 130" fill="none" aria-hidden="true">
        {type === 'report' ? (
          <>
            <path d="M56 20h50l19 19v69H56z" fill="#fff" stroke="#CAD8DE" strokeWidth="4" strokeLinejoin="round" />
            <path d="M105 21v20h20" fill="#E8F0F2" stroke="#CAD8DE" strokeWidth="4" strokeLinejoin="round" />
            <path d="M72 85V68m16 17V55m16 30V62" stroke="#4F9B83" strokeWidth="10" strokeLinecap="round" />
            <path d="M35 105c-11-8-16-19-16-32 15 4 25 14 29 30m94 2c10-8 15-19 15-32-14 4-24 14-29 30" fill="#DDF1E7" />
            <circle cx="124" cy="87" r="20" fill="#14815C" />
            <path d="m115 87 6 6 12-14" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : type === 'payment' ? (
          <>
            <path d="M50 19h58l19 19v67H50z" fill="#fff" stroke="#CAD8DE" strokeWidth="4" strokeLinejoin="round" />
            <path d="M108 20v20h19" fill="#E8F0F2" stroke="#CAD8DE" strokeWidth="4" strokeLinejoin="round" />
            <path d="M66 54h43M66 68h43M66 82h27" stroke="#A8BBC4" strokeWidth="6" strokeLinecap="round" />
            <path d="M37 99c-12-5-19-14-23-27 15 1 25 9 31 22m96 6c11-6 17-15 19-28-14 2-23 10-28 23" fill="#DDF1E7" />
            <circle cx="126" cy="91" r="20" fill="#14815C" />
            <path d="m117 91 6 6 12-14" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <rect x="22" y="22" width="136" height="86" rx="14" fill="#F8FBF9" stroke="#DCE9E3" strokeWidth="3" />
            <path d="M42 49h90M42 68h68M42 87h47" stroke="#9CB6AA" strokeWidth="6" strokeLinecap="round" />
          </>
        )}
      </svg>
      {loading && <span className="staff-empty-spinner" aria-hidden="true" />}
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  )
}

function formatPesos(value) {
  const amount = Number(value || 0)
  return `PHP ${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function localDateString(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildLoanSchedulePreview(amount, term, monthlyRate) {
  const principalCents = Math.round(Number(amount) * 100)
  const months = Number(term)
  if (!Number.isSafeInteger(principalCents) || principalCents < 1 || !Number.isInteger(months) || months < 1 || !Number.isFinite(Number(monthlyRate))) {
    return null
  }
  const interestCents = Math.round(principalCents * Math.round(Number(monthlyRate) * 100) * months / 10000)
  const principalBase = Math.floor(principalCents / months)
  const principalRemainder = principalCents % months
  const interestBase = Math.floor(interestCents / months)
  const interestRemainder = interestCents % months
  const now = new Date()
  const approvalDay = now.getDate()
  let remainingCents = principalCents + interestCents
  return Array.from({ length: months }, (_, index) => {
    const principalDue = principalBase + (index < principalRemainder ? 1 : 0)
    const interestDue = interestBase + (index < interestRemainder ? 1 : 0)
    const dueMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth() + index + 1, 1))
    const lastDay = new Date(Date.UTC(dueMonth.getUTCFullYear(), dueMonth.getUTCMonth() + 1, 0)).getUTCDate()
    dueMonth.setUTCDate(Math.min(approvalDay, lastDay))
    remainingCents -= principalDue + interestDue
    return {
      number: index + 1,
      due_date: dueMonth.toISOString().slice(0, 10),
      principal_due: (principalDue / 100).toFixed(2),
      interest_due: (interestDue / 100).toFixed(2),
      total_due: ((principalDue + interestDue) / 100).toFixed(2),
      remaining_balance: (Math.max(0, remainingCents) / 100).toFixed(2),
    }
  })
}

function printRecord() {
  const cleanUp = () => document.body.classList.remove('printing-record')
  window.addEventListener('afterprint', cleanUp, { once: true })
  document.body.classList.add('printing-record')
  window.print()
}

function SavingsLedgerDialog({ token, member, onClose }) {
  const [range, setRange] = useState({ preset: 'all', from: '', to: '' })
  const [ledger, setLedger] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const endpoint = member ? `/savings/ledger/${member.id}` : '/savings/ledger'

  useEffect(() => {
    let active = true
    if (range.preset === 'custom' && (!range.from || !range.to || range.from > range.to)) {
      return () => { active = false }
    }

    const query = new URLSearchParams()
    if (range.preset !== 'all') {
      query.set('from', range.from)
      query.set('to', range.to)
    }
    apiRequest(`${endpoint}${query.size ? `?${query}` : ''}`, { token })
      .then((result) => {
        if (active) setLedger(result)
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [endpoint, range, token])

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  function changeRange(nextRange) {
    setRange(nextRange)
    setLedger(null)
    setError(nextRange.preset === 'custom' && nextRange.from && nextRange.to && nextRange.from > nextRange.to
      ? 'The start date must be on or before the end date.'
      : '')
    setLoading(nextRange.preset !== 'custom' || Boolean(nextRange.from && nextRange.to && nextRange.from <= nextRange.to))
  }

  function choosePreset(preset) {
    const now = new Date()
    const today = localDateString(now)
    if (preset === 'all') return changeRange({ preset, from: '', to: '' })
    if (preset === 'this-month') return changeRange({ preset, from: localDateString(new Date(now.getFullYear(), now.getMonth(), 1)), to: today })
    if (preset === 'last-month') return changeRange({
      preset,
      from: localDateString(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: localDateString(new Date(now.getFullYear(), now.getMonth(), 0)),
    })
    changeRange({ preset: 'custom', from: localDateString(new Date(now.getFullYear(), now.getMonth(), 1)), to: today })
  }

  return (
    <div className="record-modal-backdrop">
      <section className="record-modal ledger-modal" role="dialog" aria-modal="true" aria-labelledby="ledger-title">
        <div className="record-modal-heading no-print">
          <div><span className="eyebrow">Savings record</span><h2 id="ledger-title">Savings ledger</h2></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close savings ledger">×</button>
        </div>
        <div className="ledger-controls no-print">
          <label>Ledger period
            <select value={range.preset} onChange={(event) => choosePreset(event.target.value)}>
              <option value="all">All activity</option>
              <option value="this-month">This month</option>
              <option value="last-month">Last month</option>
              <option value="custom">Custom date range</option>
            </select>
          </label>
          {range.preset === 'custom' && <>
            <label>From<input type="date" value={range.from} max={range.to || undefined} onChange={(event) => changeRange({ ...range, from: event.target.value })} /></label>
            <label>Through<input type="date" value={range.to} min={range.from || undefined} max={TODAY} onChange={(event) => changeRange({ ...range, to: event.target.value })} /></label>
          </>}
          <button className="button button-primary" type="button" onClick={printRecord} disabled={!ledger || loading}>Print / Save PDF</button>
        </div>
        {error && <PortalMessage error>{error}</PortalMessage>}
        {loading && <StaffEmptyState type="savings" title="Preparing savings ledger…" description="Loading the selected member’s transactions and balances." loading />}
        {ledger && !loading && <article className="ledger-print-area print-target">
          <header className="ledger-document-header">
            <div className="ledger-brand"><span className="ledger-brand-mark">C</span><span>CoopWise<small>Member savings record</small></span></div>
            <div className="ledger-document-title"><span>PASSBOOK LEDGER</span><strong> SAVINGS TRANSACTION STATEMENT</strong></div>
          </header>
          <div className="ledger-member-details">
            <div><span>Member name</span><strong>{ledger.member.full_name}</strong></div>
            <div><span>Member number</span><strong>{ledger.member.member_number}</strong></div>
            <div><span>Membership status</span><strong className={`ledger-status status-${ledger.member.status}`}>{ledger.member.status}</strong></div>
            <div><span>Statement period</span><strong>{ledger.period.from} to {ledger.period.to}</strong></div>
          </div>
          <div className="ledger-summary">
            <div><span>Opening balance</span><strong>{formatPesos(ledger.opening_balance)}</strong></div>
            <div><span>Total deposits</span><strong>{formatPesos(ledger.deposits_total)}</strong></div>
            <div><span>Total withdrawals</span><strong>{formatPesos(ledger.withdrawals_total)}</strong></div>
            <div><span>Closing balance</span><strong>{formatPesos(ledger.closing_balance)}</strong></div>
          </div>
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead><tr><th>Date / Reference</th><th>Description</th><th>Deposit (Credit)</th><th>Withdrawal (Debit)</th><th>Balance</th></tr></thead>
              <tbody>
                <tr className="ledger-opening-row"><td colSpan="4">Opening balance</td><td>{formatPesos(ledger.opening_balance)}</td></tr>
                {ledger.transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{transaction.created_at}<small>{transaction.reference_no}</small></td>
                    <td>{transaction.description || (transaction.type === 'deposit' ? 'Savings deposit' : 'Savings withdrawal')}</td>
                    <td>{transaction.type === 'deposit' ? formatPesos(transaction.amount) : '—'}</td>
                    <td>{transaction.type === 'withdrawal' ? formatPesos(transaction.amount) : '—'}</td>
                    <td>{formatPesos(transaction.balance_after)}</td>
                  </tr>
                ))}
                {!ledger.transactions.length && <tr><td className="ledger-no-transactions" colSpan="5">No savings transactions in this period.</td></tr>}
              </tbody>
              <tfoot><tr><th colSpan="2">Period totals</th><th>{formatPesos(ledger.deposits_total)}</th><th>{formatPesos(ledger.withdrawals_total)}</th><th>{formatPesos(ledger.closing_balance)}</th></tr></tfoot>
            </table>
          </div>
          <footer className="ledger-document-footer">
            <span>Generated {ledger.generated_at}</span>
            <span>This statement reflects CoopWise records for the selected period. Please contact the cooperative to confirm any discrepancy.</span>
          </footer>
        </article>}
      </section>
    </div>
  )
}

function MemberIdCardDialog({ token, memberId, onClose }) {
  const [card, setCard] = useState(null)
  const [qrImage, setQrImage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const endpoint = memberId ? `/members/${memberId}/card` : '/member-card'

  useEffect(() => {
    let active = true
    apiRequest(endpoint, { token })
      .then(async (result) => {
        const verificationUrl = new URL(window.location.href)
        verificationUrl.search = ''
        verificationUrl.hash = ''
        verificationUrl.searchParams.set('member_card', result.verification_token)
        const image = await QRCode.toDataURL(verificationUrl.toString(), {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 240,
          color: { dark: '#17362c', light: '#ffffff' },
        })
        if (active) {
          setCard(result.member)
          setQrImage(image)
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [endpoint, token])

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="record-modal-backdrop">
      <section className="record-modal member-card-modal" role="dialog" aria-modal="true" aria-labelledby="member-card-title">
        <div className="record-modal-heading no-print">
          <div><span className="eyebrow">CoopWise member services</span><h2 id="member-card-title">Member ID card</h2></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close member ID card">×</button>
        </div>
        {error && <PortalMessage error>{error}</PortalMessage>}
        {loading && <StaffEmptyState type="members" title="Preparing member card…" description="Creating a secure member verification QR code." loading />}
        {card && qrImage && <div className="member-card-print-area print-target">
          <div className="member-card-design">
            <header className="member-card-header">
              <span className="member-card-brand-mark">C</span>
              <span><strong>CoopWise</strong><small>COOPERATIVE MEMBER IDENTIFICATION</small></span>
              <span className="member-card-pill">MEMBER ID</span>
            </header>
            <div className="member-card-content">
              <div className="member-card-person">
                <span className="member-card-avatar" aria-hidden="true">{card.full_name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>
                <span className="member-card-name">{card.full_name}</span>
                <span className="member-card-number-label">MEMBER NUMBER</span>
                <strong className="member-card-number">{card.member_number}</strong>
                <span className={`member-card-status status-${card.status}`}>{card.status} member</span>
              </div>
              <div className="member-card-qr">
                <img src={qrImage} alt="QR code for secure CoopWise membership verification" />
                <span>Scan to verify membership</span>
              </div>
            </div>
            <footer className="member-card-footer">This card identifies the named CoopWise member. Membership status is checked online when scanned.</footer>
          </div>
        </div>}
        {card && <div className="member-card-actions no-print">
          <p>The QR code contains a signed member identifier only. Scanning it verifies the current membership status; it does not display savings or contact details.</p>
          <button className="button button-primary" type="button" onClick={printRecord}>Print / Save PDF</button>
        </div>}
      </section>
    </div>
  )
}

function MemberCardVerification({ verificationToken }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    apiRequest(`/member-cards/verify?token=${encodeURIComponent(verificationToken)}`)
      .then((response) => {
        if (active) setResult(response)
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [verificationToken])

  return (
    <main className="page-shell member-verification-shell">
      <a className="brand" href="/" aria-label="CoopWise home">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 27C4 15 11 7 27 5c-1 14-8 22-21 22Z" fill="currentColor" /><path d="M8 27c4-7 9-12 16-17" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" /></svg>
        <span>Coop<span>Wise</span></span>
      </a>
      <section className="member-verification-card" aria-live="polite">
        <span className={`verification-mark${error ? ' verification-invalid' : ''}`} aria-hidden="true">{loading ? '…' : error ? '!' : '✓'}</span>
        <div className="eyebrow">CoopWise member verification</div>
        <h1>{loading ? 'Checking member card…' : error ? 'Card could not be verified' : 'Member card verified'}</h1>
        {loading && <p>Checking the signed card and current membership status.</p>}
        {error && <p>{error}</p>}
        {result && <>
          <div className="verification-member">
            <span>Member name</span><strong>{result.member.full_name}</strong>
            <span>Member number</span><strong>{result.member.member_number}</strong>
            <span>Current status</span><strong className={`status status-${result.member.status}`}>{result.member.status}</strong>
          </div>
          <p className="verification-note">This verification confirms the card was issued by CoopWise and shows the member’s current status. It does not expose savings or contact details.</p>
        </>}
        <a className="button button-outline" href="/">Go to CoopWise</a>
      </section>
      <footer>CoopWise member card verification</footer>
    </main>
  )
}

function LoanPortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error, loading } = usePortalData(token, refreshKey, LOAN_ENDPOINTS)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [schedule, setSchedule] = useState(null)
  const [applicationInputs, setApplicationInputs] = useState({})
  const products = data?.[0]?.products || []
  const loans = data?.[1]?.loans || []
  const payments = data?.[2]?.payments || []
  const readiness = data?.[3]?.readiness
  const readinessAvailable = data?.[3]?.available !== false
  const readinessSubmissions = data?.[3]?.submissions || []
  const productLoadFailed = error.includes('/loan-products:')

  function refreshLoanData() {
    window.dispatchEvent(new Event('coopwise:refresh'))
  }

  async function submitReadiness(event) {
    event.preventDefault()
    const form = event.currentTarget
    const files = form.querySelector('input[name="documents[]"]').files
    if (!files.length) {
      setActionError('Attach at least one requested supporting document image.')
      return
    }
    if (files.length > 5 || [...files].some((file) => file.size > 5 * 1024 * 1024) || [...files].reduce((total, file) => total + file.size, 0) > 7 * 1024 * 1024) {
      setActionError('Attach up to five JPEG, PNG, or WebP images, no larger than 5 MB each or 7 MB combined.')
      return
    }
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/loan-readiness', { token, method: 'POST', body: new FormData(form) })
      setNotice(result.message)
      form.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

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
    const note = decision === 'reject' ? window.prompt('Optional reason for rejecting this application:') : ''
    if (note === null) return
    const review_note = note || ''
    try {
      const result = await apiRequest(`/loans/${loanId}/review`, {
        token, method: 'POST', body: JSON.stringify({ decision, review_note }),
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

  async function reviewReadiness(submissionId, decision) {
    setNotice('')
    setActionError('')
    const note = decision === 'reject' ? window.prompt('Reason for requesting corrected loan documents:') : ''
    if (note === null) return
    const review_note = note || ''
    try {
      const result = await apiRequest(`/loan-readiness/${submissionId}/review`, {
        token, method: 'POST', body: JSON.stringify({ decision, review_note }),
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function toggleProduct(product) {
    setNotice('')
    setActionError('')
    try {
      await apiRequest(`/loan-products/${product.id}`, {
        token,
        method: 'PUT',
        body: JSON.stringify({
          name: product.name,
          description: product.description || '',
          interest_rate: product.interest_rate,
          max_amount: product.max_amount,
          max_term_months: product.max_term_months,
          status: product.status === 'active' ? 'inactive' : 'active',
        }),
      })
      setNotice(`Loan offer ${product.status === 'active' ? 'paused' : 'made available'} for members.`)
      refreshLoanData()
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return (
    <section className="portal-section">
      {!standalone && <div className="section-heading">
        <div>
          <div className="eyebrow">Credit services</div>
          <h2>Monthly loans</h2>
          <p className="muted">Review your document status and explore available loan offers.</p>
        </div>
        <button className="button button-outline" type="button" onClick={refreshLoanData} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh status'}
        </button>
      </div>}
      {standalone && <div className="standalone-actions"><button className="button button-outline" type="button" onClick={refreshLoanData} disabled={loading}>{loading ? 'Checking…' : 'Refresh status'}</button></div>}
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
      {loading && <p className="loading-note" role="status">Loading your loan information…</p>}

      {!loading && staff && (
        <section>
          <h3>Loan document reviews</h3>
          {data && readinessSubmissions.length === 0 && <p className="muted">No loan documents are waiting for review.</p>}
          {readinessSubmissions.map((submission) => (
            <article className="portal-card" key={submission.id}>
              <div className="item-heading">
                <div><strong>{submission.first_name} {submission.last_name}</strong><span>{submission.member_number} · Submitted {submission.created_at}</span></div>
                <span className="status status-pending">pending</span>
              </div>
              <ul className="document-list">{submission.documents.map((document) => (
                <li key={document.id}>
                  <span>{document.original_name} · {Math.ceil(document.file_size / 1024)} KB</span>
                  <button className="text-button" type="button" onClick={async () => {
                    try { await openProtectedImage(token, `/loan-documents/${document.id}`) } catch (requestError) { setActionError(requestError.message) }
                  }}>Open image</button>
                </li>
              ))}</ul>
              <div className="button-row">
                <button className="button button-primary" type="button" onClick={() => reviewReadiness(submission.id, 'approve')}>Approve documents</button>
                <button className="button button-outline" type="button" onClick={() => reviewReadiness(submission.id, 'reject')}>Request corrections</button>
              </div>
            </article>
          ))}
        </section>
      )}
      {!loading && staff ? (
        <>
          <section className="offers-section">
            <h3>Loan offers</h3>
            {products.length === 0
              ? <p className="notice">No loan offers are configured yet. Create an active offer below so approved members can view it.</p>
              : <div className="offer-grid">{products.map((product) => (
                <article className="offer-card" key={product.id}>
                  <div className="offer-card-heading">
                    <div><h4>{product.name}</h4><p>{product.description || 'Cooperative loan offer'}</p></div>
                    <span className={`status status-${product.status}`}>{product.status}</span>
                  </div>
                  <dl className="offer-facts">
                    <div><dt>Monthly rate</dt><dd>{product.interest_rate}%</dd></div>
                    <div><dt>Maximum amount</dt><dd>PHP {product.max_amount}</dd></div>
                    <div><dt>Maximum term</dt><dd>{product.max_term_months} months</dd></div>
                  </dl>
                  <button className="button button-outline" type="button" onClick={() => toggleProduct(product)}>
                    {product.status === 'active' ? 'Pause offer' : 'Make available'}
                  </button>
                </article>
              ))}</div>}
          </section>
          <details className="portal-card">
            <summary>Create loan offer</summary>
            <form className="form-grid" onSubmit={(event) => submit(event, '/loan-products', 'POST', 'Loan offer created.')}>
              <label>Product name<input name="name" required maxLength="100" /></label>
              <label>Monthly interest rate (%)<input name="interest_rate" type="number" min="0" max="99.99" step="0.01" required /></label>
              <label>Maximum amount (PHP)<input name="max_amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Maximum term (months)<input name="max_term_months" type="number" min="1" max="120" required /></label>
              <label className="full">Description<input name="description" maxLength="255" /></label>
              <button className="button button-primary" type="submit">Create active offer</button>
            </form>
          </details>
        </>
      ) : !loading && (
        <>
          {!readinessAvailable ? <p className="notice">Loan document review and loan applications are available to members aged 18 and over.</p> : (
            <section className="portal-card">
              <h3>Loan document approval</h3>
              {readiness?.status === 'pending' && <p className="notice">Your loan documents are waiting for staff review. Loan offers will appear here after approval.</p>}
              {readiness?.status === 'approved' && <p className="notice">Your loan documents have been approved. You can now view the available loan offers below.</p>}
              {readiness?.status === 'rejected' && <p className="message message-error">Your loan documents need corrections. Staff note: {readiness.review_note || 'Please upload a corrected document set.'}</p>}
              {!error && readiness?.status !== 'pending' && readiness?.status !== 'approved' && (
                <form className="form-grid" onSubmit={submitReadiness}>
                  <label className="full">Supporting document images
                    <input name="documents[]" type="file" accept="image/jpeg,image/png,image/webp" multiple required />
                    <small>Attach up to five images, 5 MB each and 7 MB combined. Follow the checklist given by your cooperative; requirements vary by product. Common examples may include a valid ID and proof of income or livelihood.</small>
                  </label>
                  <button className="button button-primary" type="submit">Submit documents for review</button>
                </form>
              )}
              {readiness && data?.[3]?.documents?.length > 0 && (
                <ul className="document-list">{data[3].documents.map((document) => (
                  <li key={document.id}>
                    <span>{document.original_name} · {Math.ceil(document.file_size / 1024)} KB</span>
                    <button className="text-button" type="button" onClick={async () => {
                      try { await openProtectedImage(token, `/loan-documents/${document.id}`) } catch (requestError) { setActionError(requestError.message) }
                    }}>Open image</button>
                  </li>
                ))}</ul>
              )}
            </section>
          )}
          {readiness?.status === 'approved' && (
            <section className="offers-section">
              <div className="section-heading section-heading-compact">
                <div><h3>Available loan offers</h3><p className="muted">Choose an offer to see its application form.</p></div>
              </div>
              {products.length === 0
                ? <p className="notice">{productLoadFailed
                  ? 'Your documents are approved, but loan offers could not be loaded. Use Refresh status to try again or contact cooperative staff.'
                  : 'Your documents are approved, but there are no active loan offers yet. Please check back later or contact cooperative staff.'}</p>
                : <div className="offer-grid">{products.map((product) => (
                  <article className="offer-card" key={product.id}>
                    <div className="offer-card-heading">
                      <div><h4>{product.name}</h4><p>{product.description || 'Cooperative loan offer'}</p></div>
                      <span className="status status-active">Available</span>
                    </div>
                    <dl className="offer-facts">
                      <div><dt>Monthly rate</dt><dd>{product.interest_rate}%</dd></div>
                      <div><dt>Maximum amount</dt><dd>PHP {product.max_amount}</dd></div>
                      <div><dt>Maximum term</dt><dd>{product.max_term_months} months</dd></div>
                    </dl>
                    <details className="offer-application">
                      <summary>Apply for this offer</summary>
                      <form className="form-grid" onSubmit={(event) => submit(event, '/loans', 'POST', 'Loan application submitted.')}>
                        <input type="hidden" name="loan_type_id" value={product.id} />
                        <label>Amount (PHP)<input name="amount" type="number" min="0.01" max={product.max_amount} step="0.01" required onChange={(event) => setApplicationInputs({ ...applicationInputs, [product.id]: { ...applicationInputs[product.id], amount: event.target.value } })} /></label>
                        <label>Term (months)<input name="term_months" type="number" min="1" max={product.max_term_months} required onChange={(event) => setApplicationInputs({ ...applicationInputs, [product.id]: { ...applicationInputs[product.id], term: event.target.value } })} /></label>
                        <label className="full">Purpose<input name="purpose" maxLength="255" required /></label>
                        {buildLoanSchedulePreview(applicationInputs[product.id]?.amount, applicationInputs[product.id]?.term, product.interest_rate) && (
                          <div className="loan-preview full">
                            <strong>Estimated repayment schedule</strong>
                            <p>Flat interest is calculated on the original principal: principal × monthly rate × term. Due dates are estimates based on approval this month.</p>
                            <div className="table-wrap"><table><thead><tr><th>#</th><th>Estimated due date</th><th>Principal</th><th>Interest</th><th>Installment</th><th>Remaining</th></tr></thead>
                              <tbody>{buildLoanSchedulePreview(applicationInputs[product.id]?.amount, applicationInputs[product.id]?.term, product.interest_rate).map((row) => (
                                <tr key={row.number}><td>{row.number}</td><td>{row.due_date}</td><td>{formatPesos(row.principal_due)}</td><td>{formatPesos(row.interest_due)}</td><td>{formatPesos(row.total_due)}</td><td>{formatPesos(row.remaining_balance)}</td></tr>
                              ))}</tbody>
                            </table></div>
                            <small>This is an estimate, not approval. The final schedule is generated after staff approval.</small>
                          </div>
                        )}
                        <button className="button button-primary" type="submit">Submit application</button>
                      </form>
                    </details>
                  </article>
                ))}</div>}
            </section>
          )}
        </>
      )}

      {!loading && <h3>{staff ? 'Applications and active loans' : 'Your loans'}</h3>}
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
          {loan.review_note && <p className="notice">Review note: {loan.review_note}</p>}
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
        <div className="record-modal-backdrop">
          <section className="record-modal loan-schedule-modal" role="dialog" aria-modal="true" aria-labelledby="loan-schedule-title">
            <div className="record-modal-heading no-print">
              <div><span className="eyebrow">Credit services</span><h2 id="loan-schedule-title">{schedule.loan.loan_code} repayment schedule</h2></div>
              <div className="button-row"><button className="button button-primary" type="button" onClick={printRecord}>Print / Save PDF</button><button className="modal-close" type="button" onClick={() => setSchedule(null)} aria-label="Close repayment schedule">×</button></div>
            </div>
            <article className="loan-schedule-print-area print-target">
              <header className="ledger-document-header"><div className="ledger-brand"><span className="ledger-brand-mark">C</span><span>CoopWise<small>Loan repayment plan</small></span></div><div className="ledger-document-title"><span>AMORTIZATION</span><strong>MONTHLY FLAT-INTEREST SCHEDULE</strong></div></header>
              <div className="loan-schedule-summary">
                <div><span>Loan</span><strong>{schedule.loan.loan_code} · {schedule.loan.loan_type_name}</strong></div>
                <div><span>Principal</span><strong>{formatPesos(schedule.loan.approved_amount)}</strong></div>
                <div><span>Monthly rate</span><strong>{schedule.loan.interest_rate}%</strong></div>
                <div><span>Term / total interest</span><strong>{schedule.loan.term_months} months · {formatPesos(schedule.total_interest)}</strong></div>
              </div>
              <p className="loan-schedule-explanation">Interest uses the cooperative’s current flat-interest rule: approved principal × monthly rate × term. Installments are equal, with any rounding cents distributed across early installments. Remaining shows unpaid installments after each row.</p>
              <div className="table-wrap"><table className="loan-schedule-table"><thead><tr><th>#</th><th>Due date</th><th>Principal</th><th>Interest</th><th>Installment</th><th>Paid</th><th>Remaining after</th><th>Status</th></tr></thead>
                <tbody>{schedule.schedule.map((item, index) => <tr key={item.id}><td>{index + 1}</td><td>{item.due_date}</td><td>{formatPesos(item.principal_due)}</td><td>{formatPesos(item.interest_due)}</td><td>{formatPesos(item.total_due)}</td><td>{formatPesos(item.paid_amount)}</td><td>{formatPesos(item.remaining_after)}</td><td>{item.status}</td></tr>)}</tbody>
                <tfoot><tr><th colSpan="2">Totals</th><th>{formatPesos(schedule.total_principal)}</th><th>{formatPesos(schedule.total_interest)}</th><th>{formatPesos(schedule.total_due)}</th><th>{formatPesos(schedule.total_paid)}</th><th>{formatPesos(schedule.loan.current_balance)}</th><th /></tr></tfoot>
              </table></div>
              <footer className="ledger-document-footer"><span>Generated {schedule.generated_at}</span><span>Actual payments and account balances may change this schedule. Contact cooperative staff for clarification.</span></footer>
            </article>
          </section>
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

function CooperativePortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error, loading } = usePortalData(token, refreshKey, COOPERATIVE_ENDPOINTS)
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
      {!standalone && <>
        <h2>Daily rotating savings (Paluwagan)</h2>
        <p className="muted">Members contribute the set amount each day. When everyone has contributed, the next person in the agreed payout order is ready to receive the pooled amount; staff confirms when the payout is made.</p>
      </>}
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

      {loading && !data && <StaffEmptyState type="cooperative" title="Loading daily cycles…" description="Please wait while we fetch the latest cycle and contribution details." loading />}
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

function MembersPortal({ token, standalone = false }) {
  const [query, setQuery] = useState('')
  const [members, setMembers] = useState([])
  const [selectedMember, setSelectedMember] = useState(null)
  const [ledgerMember, setLedgerMember] = useState(null)
  const [cardMemberId, setCardMemberId] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError('')
      apiRequest(`/members?q=${encodeURIComponent(query.trim())}`, { token })
        .then((result) => {
          if (active) setMembers(result.members || [])
        })
        .catch((requestError) => {
          if (active) setError(requestError.message)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, query ? 250 : 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [token, query])

  return (
    <section className="portal-section">
      <div className="section-heading members-heading">
        {!standalone && <div><h2>Members</h2><p className="muted">Member directory and account status.</p></div>}
        <span className="status" aria-live="polite">{members.length} shown</span>
      </div>
      <div className="member-search-layout">
        <label className="member-search-field">Search members
        <input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedMember(null) }} placeholder="Type a name, member number, or email" />
        </label>
        <small className="member-search-help">Results update as you type. Names may match anywhere; member numbers, phones, and emails match from the beginning.</small>
      </div>
      <PortalMessage error>{error}</PortalMessage>
      {loading && <StaffEmptyState type="members" title="Loading members…" description="Please wait while we search the member directory." loading />}
      {!loading && !error && members.length === 0 && <StaffEmptyState type="members" title="No matching members" description="Try another name, member number, phone, or email address." />}
      {!!members.length && <div className="table-wrap"><table>
        <thead><tr><th>Member #</th><th>Name</th><th>Phone</th><th>Email</th><th>Account</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{members.map((member) => <tr key={member.id}>
          <td>{member.member_number}</td>
          <td>{member.first_name} {member.middle_name ? `${member.middle_name} ` : ''}{member.last_name}</td>
          <td>{member.contact_number || '—'}</td>
          <td>{member.email || '—'}</td>
          <td>{member.account_role}</td>
          <td><span className={`status status-${member.status}`}>{member.status}</span></td>
          <td><div className="member-row-actions">
            <button className="text-button" type="button" onClick={() => setLedgerMember(member)}>Savings ledger</button>
            <button className="text-button" type="button" onClick={() => setCardMemberId(member.id)}>ID card</button>
            <button className="text-button" type="button" onClick={() => setSelectedMember(selectedMember === member.id ? null : member.id)}>
              {selectedMember === member.id ? 'Close' : 'Details'}
            </button>
          </div></td>
        </tr>)}</tbody>
      </table></div>}
      {selectedMember && members.filter((member) => member.id === selectedMember).map((member) => (
        <article className="portal-card member-detail" key={member.id}>
          <div className="item-heading"><strong>{member.first_name} {member.middle_name ? `${member.middle_name} ` : ''}{member.last_name}</strong><span>Member #{member.member_number}</span></div>
          <p>Phone: {member.contact_number || 'Not provided'} · Email: {member.email || 'Not provided'}</p>
          <p>Address: {member.address || 'Not provided'} · Date of birth: {member.birth_date || 'Not provided'}</p>
          <p>Account role: {member.account_role} · Membership status: {member.status}</p>
        </article>
      ))}
      {ledgerMember && <SavingsLedgerDialog token={token} member={ledgerMember} onClose={() => setLedgerMember(null)} />}
      {cardMemberId && <MemberIdCardDialog token={token} memberId={cardMemberId} onClose={() => setCardMemberId(null)} />}
    </section>
  )
}

function SavingsPortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error, loading } = usePortalData(token, refreshKey, SAVINGS_ENDPOINTS)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [withdrawalRequests, setWithdrawalRequests] = useState([])
  const [withdrawalLoading, setWithdrawalLoading] = useState(true)
  const [withdrawalFilters, setWithdrawalFilters] = useState({ q: '', status: 'all', sort: 'newest', page: 1 })
  const [withdrawalSearch, setWithdrawalSearch] = useState('')
  const [withdrawalConfirmation, setWithdrawalConfirmation] = useState(null)
  const [withdrawalSummary, setWithdrawalSummary] = useState({ page: 1, pages: 1, total: 0 })
  const [autoPayDraft, setAutoPayDraft] = useState(null)
  const [autoPaySaving, setAutoPaySaving] = useState(false)
  const transactions = data?.[0]?.transactions || []
  const members = data?.[0]?.members || []
  const balance = data?.[0]?.balance
  const autoPaySettings = autoPayDraft || data?.[0]?.auto_pay_preferences || { loan: false, paluwagan: false }

  useEffect(() => {
    let active = true
    const query = new URLSearchParams(withdrawalFilters)
    apiRequest(`/savings/withdrawals?${query}`, { token })
      .then((result) => {
        if (active) {
          setWithdrawalRequests(result.withdrawals || [])
          setWithdrawalSummary({ page: result.page || 1, pages: result.pages || 1, total: result.total || 0 })
        }
      })
      .catch((requestError) => { if (active) setActionError(requestError.message) })
      .finally(() => { if (active) setWithdrawalLoading(false) })
    return () => { active = false }
  }, [token, refreshKey, withdrawalFilters])

  async function saveAutoPay(event) {
    event.preventDefault()
    setNotice('')
    setActionError('')
    setAutoPaySaving(true)
    try {
      const result = await apiRequest('/savings/auto-pay', {
        token, method: 'POST', body: JSON.stringify(autoPaySettings),
      })
      setAutoPayDraft(result.auto_pay_preferences)
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setAutoPaySaving(false)
    }
  }

  function prepareWithdrawal(event) {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    if (values.gcash_number !== values.confirm_gcash_number) {
      setActionError('The GCash numbers do not match. Check both fields and try again.')
      return
    }
    setActionError('')
    setWithdrawalConfirmation(values)
  }

  async function submitWithdrawal() {
    if (!withdrawalConfirmation) return
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/savings/withdrawals', {
        token, method: 'POST', body: JSON.stringify(withdrawalConfirmation),
      })
      setNotice(result.message)
      setWithdrawalConfirmation(null)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function uploadWithdrawalReceipt(event, requestId) {
    event.preventDefault()
    const form = event.currentTarget
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest(`/savings/withdrawals/${requestId}/receipt`, {
        token, method: 'POST', body: new FormData(form),
      })
      setNotice(result.message)
      form.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function reviewWithdrawal(request, action) {
    setNotice('')
    setActionError('')
    let admin_note = ''
    if (action === 'reject') {
      admin_note = window.prompt('Enter the reason for rejecting this request. The reserved savings will be refunded.')
      if (admin_note === null) return
      admin_note = admin_note.trim()
      if (!admin_note) {
        setActionError('Enter a rejection reason before continuing.')
        return
      }
    } else {
      admin_note = window.prompt('Optional note for this completed transfer:') || ''
    }
    try {
      const result = await apiRequest(`/savings/withdrawals/${request.id}/${action}`, {
        token, method: 'POST', body: JSON.stringify({ admin_note }),
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function recordTransaction(event) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/savings', { token, method: 'POST', body: JSON.stringify(values) })
      setNotice(result.message)
      form.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  function withdrawalPagination() {
    if (withdrawalSummary.pages <= 1) return null
    return <div className="withdrawal-pagination"><span>{withdrawalSummary.total} requests · Page {withdrawalSummary.page} of {withdrawalSummary.pages}</span><div className="button-row">
      <button className="button button-outline" type="button" disabled={withdrawalSummary.page <= 1 || withdrawalLoading} onClick={() => { setWithdrawalLoading(true); setWithdrawalFilters({ ...withdrawalFilters, page: withdrawalSummary.page - 1 }) }}>Previous</button>
      <button className="button button-outline" type="button" disabled={withdrawalSummary.page >= withdrawalSummary.pages || withdrawalLoading} onClick={() => { setWithdrawalLoading(true); setWithdrawalFilters({ ...withdrawalFilters, page: withdrawalSummary.page + 1 }) }}>Next</button>
    </div></div>
  }

  return (
    <section className="portal-section">
      {!standalone && <h2>Savings</h2>}
      {!staff && <div className="savings-member-overview">
        <div className="portal-card savings-balance"><span>Your available savings</span><strong>{loading && !data ? 'Loading…' : formatPesos((balance || 0) / 100)}</strong></div>
        <button className="button button-primary" type="button" onClick={() => setLedgerOpen(true)}>View / print my savings ledger</button>
      </div>}
      {!staff && data && (
        <form className="portal-card autopay-card" onSubmit={saveAutoPay}>
          <div className="autopay-heading"><div><span className="eyebrow">Optional convenience</span><h3>Automatic payments from savings</h3></div><button className="button button-primary" type="submit" disabled={autoPaySaving}>{autoPaySaving ? 'Saving…' : 'Save choices'}</button></div>
          <p>These choices are off until you opt in. When enabled, the daily payment job pays due amounts only when funds are available and records each savings withdrawal and matching payment. You can turn either option off at any time.</p>
          <label className="autopay-option"><input type="checkbox" checked={autoPaySettings.loan} onChange={(event) => setAutoPayDraft({ ...autoPaySettings, loan: event.target.checked })} /><span><strong>Loan installments</strong><small>Pay due loan installments from savings. If funds are short, an available partial amount may be applied to the earliest due installment.</small></span></label>
          <label className="autopay-option"><input type="checkbox" checked={autoPaySettings.paluwagan} onChange={(event) => setAutoPayDraft({ ...autoPaySettings, paluwagan: event.target.checked })} /><span><strong>Daily Paluwagan contributions</strong><small>Pay the active cycle’s daily contribution from savings when the cycle is due and the funds are available.</small></span></label>
          <p className="autopay-caveat">Auto-pay runs only after the cooperative configures the recurring daily job. Savings withdrawals and their loan or Paluwagan records are saved together.</p>
        </form>
      )}
      {staff && <p className="muted savings-staff-hint">To preview or print a member’s passbook-style savings ledger, open the Members directory and choose <strong>Savings ledger</strong> for that member.</p>}
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
      {!staff && (
        <section className="withdrawal-section">
          <div className="staff-subsection-title"><StaffIcon name="savings" /><div><h3>Withdraw to GCash</h3><p className="muted">Request a transfer of available savings to your GCash account.</p></div></div>
          {withdrawalConfirmation ? (
            <article className="portal-card withdrawal-confirm-card">
              <span className="eyebrow">Final confirmation</span>
              <h4>Double-check your transfer details</h4>
              <dl><div><dt>Amount</dt><dd>{formatPesos(withdrawalConfirmation.amount)}</dd></div><div><dt>GCash account name</dt><dd>{withdrawalConfirmation.gcash_account_name}</dd></div><div><dt>GCash number</dt><dd>{withdrawalConfirmation.gcash_number}</dd></div></dl>
              <p>Submitting reserves this amount from your savings. Staff will send the GCash transfer manually and attach a receipt. If your request is rejected, the reserved amount will be refunded to your savings.</p>
              <div className="button-row"><button className="button button-primary" type="button" onClick={submitWithdrawal}>Confirm withdrawal request</button><button className="button button-outline" type="button" onClick={() => setWithdrawalConfirmation(null)}>Edit details</button></div>
            </article>
          ) : (
            <form className="portal-card form-grid withdrawal-form" onSubmit={prepareWithdrawal}>
              <label>Amount (PHP)<input name="amount" type="number" min="0.01" max={((balance || 0) / 100).toFixed(2)} step="0.01" required /></label>
              <label>GCash account name<input name="gcash_account_name" maxLength="120" autoComplete="name" required /></label>
              <label>GCash mobile number<input name="gcash_number" type="tel" inputMode="numeric" pattern="09[0-9]{9}" maxLength="11" placeholder="09XXXXXXXXX" required /></label>
              <label>Confirm GCash mobile number<input name="confirm_gcash_number" type="tel" inputMode="numeric" pattern="09[0-9]{9}" maxLength="11" placeholder="Enter the same number again" required /></label>
              <button className="button button-primary" type="submit">Review withdrawal details</button>
              <p className="withdrawal-disclaimer full">This is a manual transfer request, not an instant GCash integration. Do not share your GCash PIN or one-time password.</p>
            </form>
          )}
          <h4>Your withdrawal history</h4>
          {withdrawalLoading ? <p className="muted">Loading your requests…</p> : withdrawalRequests.length === 0 ? <p className="muted">No GCash withdrawal requests yet.</p> : (
            <div className="withdrawal-list">{withdrawalRequests.map((request) => (
              <article className="portal-card withdrawal-item" key={request.id}>
                <div className="item-heading"><div><strong>{formatPesos(request.amount)}</strong><span>{request.request_reference} · {request.requested_at}</span></div><span className={`status status-${request.status}`}>{request.status}</span></div>
                {request.admin_note && <p className="muted">Staff note: {request.admin_note}</p>}
                {request.has_receipt && <button className="text-button" type="button" onClick={async () => { try { await openProtectedImage(token, `/savings/withdrawals/${request.id}/receipt`) } catch (requestError) { setActionError(requestError.message) } }}>View transfer receipt</button>}
              </article>
            ))}</div>
          )}
          {withdrawalPagination()}
        </section>
      )}
      {staff && (
        <section className="withdrawal-section">
          <div className="staff-subsection-title"><StaffIcon name="savings" /><div><h3>GCash withdrawal requests</h3><p className="muted">Review reserved savings, send the transfer manually, then attach proof before completing.</p></div></div>
          <form className="portal-card withdrawal-filters" onSubmit={(event) => { event.preventDefault(); setWithdrawalLoading(true); setWithdrawalFilters({ ...withdrawalFilters, q: withdrawalSearch.trim(), page: 1 }) }}>
            <label>Search<input value={withdrawalSearch} onChange={(event) => setWithdrawalSearch(event.target.value)} placeholder="Member, number, name, or reference" /></label>
            <label>Status<select value={withdrawalFilters.status} onChange={(event) => { setWithdrawalLoading(true); setWithdrawalFilters({ ...withdrawalFilters, status: event.target.value, page: 1 }) }}><option value="all">All requests</option><option value="pending">Pending</option><option value="completed">Completed</option><option value="rejected">Rejected</option></select></label>
            <label>Sort<select value={withdrawalFilters.sort} onChange={(event) => { setWithdrawalLoading(true); setWithdrawalFilters({ ...withdrawalFilters, sort: event.target.value, page: 1 }) }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="amount_desc">Highest amount</option><option value="amount_asc">Lowest amount</option><option value="member">Member name</option></select></label>
            <button className="button button-outline" type="submit">Search</button>
          </form>
          {withdrawalLoading ? <p className="muted">Loading withdrawal requests…</p> : withdrawalRequests.length === 0 ? <p className="muted">No withdrawal requests match these filters.</p> : (
            <div className="withdrawal-list">{withdrawalRequests.map((request) => (
              <article className="portal-card withdrawal-item" key={request.id}>
                <div className="item-heading"><div><strong>{request.first_name} {request.last_name} · {formatPesos(request.amount)}</strong><span>{request.member_number} · {request.request_reference} · {request.requested_at}</span></div><span className={`status status-${request.status}`}>{request.status}</span></div>
                <p><strong>Send to:</strong> {request.gcash_account_name} · {request.gcash_number}</p>
                {request.admin_note && <p className="muted">Staff note: {request.admin_note}</p>}
                {request.has_receipt && <button className="text-button" type="button" onClick={async () => { try { await openProtectedImage(token, `/savings/withdrawals/${request.id}/receipt`) } catch (requestError) { setActionError(requestError.message) } }}>View attached receipt</button>}
                {request.status === 'pending' && <div className="withdrawal-actions">
                  <form className="withdrawal-upload-form" onSubmit={(event) => uploadWithdrawalReceipt(event, request.id)}>
                    <label>GCash transfer receipt<input name="receipt" type="file" accept="image/jpeg,image/png,image/webp" required /></label>
                    <button className="button button-outline" type="submit">{request.has_receipt ? 'Replace receipt' : 'Attach receipt'}</button>
                  </form>
                  <div className="button-row"><button className="button button-primary" type="button" disabled={!request.has_receipt} onClick={() => reviewWithdrawal(request, 'complete')}>Complete transfer</button><button className="button button-outline" type="button" onClick={() => reviewWithdrawal(request, 'reject')}>Reject and refund</button></div>
                </div>}
              </article>
            ))}</div>
          )}
          {withdrawalPagination()}
        </section>
      )}
      {staff && (
        <details className="portal-card" open>
          <summary>Record savings transaction</summary>
          <form className="form-grid" onSubmit={recordTransaction}>
            <label>Member<select name="member_id" required defaultValue=""><option value="" disabled>Select a member</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.member_number} · {member.first_name} {member.last_name}</option>)}
            </select></label>
            <label>Transaction<select name="type" required defaultValue="deposit"><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></label>
            <label>Amount (PHP)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Description (optional)<input name="description" maxLength="255" /></label>
            <button className="button button-primary" type="submit">Save transaction</button>
          </form>
        </details>
      )}
      <div className="staff-subsection-title"><StaffIcon name="savings" /><h3>Transaction history</h3></div>
      {loading && !data && <StaffEmptyState type="savings" title="Loading savings history…" description="Please wait while we fetch the latest transactions." loading />}
      {data && transactions.length === 0 && <p className="muted">No savings transactions recorded.</p>}
      {!!transactions.length && <div className="table-wrap"><table><thead><tr>
        <th>Date</th>{staff && <th>Member</th>}<th>Type</th><th>Amount</th><th>Balance after</th><th>Reference</th><th>Description</th>
      </tr></thead><tbody>{transactions.map((entry) => <tr key={entry.id}>
        <td>{entry.created_at}</td>{staff && <td>{entry.member_number} · {entry.first_name} {entry.last_name}</td>}
        <td>{entry.type}</td><td>PHP {entry.amount}</td><td>PHP {entry.balance_after}</td><td>{entry.reference_no}</td><td>{entry.description || '—'}</td>
      </tr>)}</tbody></table></div>}
      {ledgerOpen && <SavingsLedgerDialog token={token} member={null} onClose={() => setLedgerOpen(false)} />}
    </section>
  )
}

function ReportsPortal({ token, refreshKey, standalone = false }) {
  const { data, error, loading } = usePortalData(token, refreshKey, REPORT_ENDPOINTS)
  const report = data?.[0]
  return (
    <section className="portal-section">
      <PortalMessage error>{error}</PortalMessage>
      {!report && !error && <StaffEmptyState
        type="report"
        title={loading ? 'Loading current figures…' : 'No report figures yet.'}
        description={loading ? 'Please wait while we fetch the latest data.' : 'Recorded cooperative totals will appear here.'}
        loading={loading}
      />}
      {report && <>
        {!standalone && <h2>Reports</h2>}
        <p className="muted">Live totals from recorded CoopWise transactions. Monthly activity: {report.period}. Pending payment evidence is not counted as received funds.</p>
        <div className="report-grid">
          <article className="portal-card"><span>Members</span><strong>{report.summary.members}</strong><small>{report.summary.active_members} active</small></article>
          <article className="portal-card"><span>Savings balance</span><strong>PHP {report.summary.savings_balance}</strong></article>
          <article className="portal-card"><span>Loan portfolio</span><strong>PHP {report.summary.loan_balance}</strong></article>
          <article className="portal-card"><span>Loan payments received</span><strong>PHP {report.summary.loan_payments_received}</strong></article>
          <article className="portal-card"><span>Payment evidence awaiting review</span><strong>{report.pending_payment_submissions}</strong></article>
        </div>
        <h3>Monthly activity</h3>
        <div className="table-wrap"><table><thead><tr><th>Activity</th><th>Value</th></tr></thead><tbody>
          <tr><td>New members</td><td>{report.monthly.new_members}</td></tr>
          <tr><td>Savings deposits</td><td>PHP {report.monthly.savings_deposits}</td></tr>
          <tr><td>Savings withdrawals</td><td>PHP {report.monthly.savings_withdrawals}</td></tr>
          <tr><td>Loan payments received</td><td>PHP {report.monthly.loan_payments_received}</td></tr>
        </tbody></table></div>
        <h3>Loan applications by status</h3>
        {Object.keys(report.monthly.loan_applications).length
          ? <ul className="member-order">{Object.entries(report.monthly.loan_applications).map(([status, count]) => <li key={status}>{status}: {count}</li>)}</ul>
          : <p className="muted">No loan applications this month.</p>}
      </>}
    </section>
  )
}

function PaymentPortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error, loading } = usePortalData(token, refreshKey, PAYMENT_ENDPOINTS)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [filter, setFilter] = useState('all')
  const loans = data?.[0]?.loans || []
  const cycles = data?.[1]?.cycles || []
  const submissions = data?.[2]?.submissions || []
  const [category, setCategory] = useState('loan')

  async function submitPayment(event) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    if (!values.get('reference_no') && !values.get('screenshot')?.size) {
      setActionError('Upload your payment screenshot or enter the transaction reference number.')
      return
    }
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/payment-submissions', { token, method: 'POST', body: values })
      setNotice(result.message)
      form.reset()
      setCategory('loan')
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function reviewSubmission(id, decision) {
    setNotice('')
    setActionError('')
    if (decision === 'approve' && !window.confirm('Only approve if you have independently confirmed the funds were received. This verifies evidence but does not post it to a balance. Continue?')) return
    const note = window.prompt(decision === 'reject' ? 'Reason for rejection (recommended):' : 'Optional verification note:')
    if (note === null) return
    const review_note = note || ''
    try {
      const result = await apiRequest(`/payment-submissions/${id}/review`, {
        token, method: 'POST', body: JSON.stringify({ decision, review_note }),
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return (
    <section className="portal-section">
      <div className="section-heading">
        {!standalone && <div>
          <div className="eyebrow">{staff ? 'Payment review' : 'Member payments'}</div>
          <h2>{staff ? 'Payment submissions' : 'Submit a payment'}</h2>
          <p className="muted">{staff
            ? 'Review submitted amounts, references, screenshots, and related loan or Paluwagan cycle.'
            : 'Submit a GCash receipt or reference number for staff review.'}</p>
        </div>}
        {staff && <label className="filter-control">Payment type
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All payments</option>
            <option value="loan">Loan repayments</option>
            <option value="paluwagan">Paluwagan contributions</option>
            <option value="cooperative">Cooperative payments</option>
          </select>
        </label>}
      </div>
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
      {!staff && (
        <div className="portal-card payment-instructions">
          <h3>Pay via QR code</h3>
          <img className="payment-qr" src="/gcash-qr.jpg" alt="GCash payment QR code" />
          <ol>
            <li>Scan the QR code in GCash and send the amount shown in your payment details.</li>
            <li>Take a screenshot of the completed payment.</li>
            <li>Attach the screenshot below, or enter the transaction reference number if you cannot upload a screenshot.</li>
          </ol>
          <p className="muted">A screenshot or reference number is only evidence for staff review. It does not confirm that funds were received.</p>
        </div>
      )}
      {!staff && (
        <form className="portal-card form-grid" onSubmit={submitPayment}>
          <label>Payment for
            <select name="category" value={category} onChange={(event) => setCategory(event.target.value)} required>
              <option value="loan">Loan repayment</option>
              <option value="cooperative">Cooperative payment</option>
              <option value="paluwagan">Paluwagan contribution</option>
            </select>
          </label>
          {category === 'loan' && (
            <label>Loan
              <select name="loan_id" required defaultValue="">
                <option value="" disabled>Select a loan</option>
                {loans.filter((loan) => ['approved', 'active'].includes(loan.status)).map((loan) => <option key={loan.id} value={loan.id}>{loan.loan_code} · Balance PHP {loan.current_balance}</option>)}
              </select>
            </label>
          )}
          {category === 'paluwagan' && (
            <label>Active Paluwagan cycle
              <select name="cycle_id" required defaultValue="">
                <option value="" disabled>Select a cycle</option>
                {cycles.filter((cycle) => cycle.status === 'active').map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name} · PHP {cycle.daily_contribution} daily</option>)}
              </select>
            </label>
          )}
          <label>Amount (PHP)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
          <label>Transaction reference number (if available)<input name="reference_no" maxLength="100" placeholder="Enter the GCash reference number" /></label>
          <label className="full">Payment screenshot (optional if you enter a reference number)
            <input name="screenshot" type="file" accept="image/jpeg,image/png,image/webp" />
            <small>JPEG, PNG, or WebP; up to 5 MB.</small>
          </label>
          <button className="button button-primary full" type="submit">Submit payment evidence</button>
        </form>
      )}
      {!staff && <h3>Your payment submissions</h3>}
      {loading && <StaffEmptyState type="payment" title="Loading payment submissions…" description="Please wait while we check for recent submissions." loading />}
      {!loading && !error && !staff && data && submissions.length === 0 && <StaffEmptyState type="payment" title="No payment submissions yet." description="When you submit a payment, it will appear here." />}
      {!loading && !error && staff && data && !submissions.some((submission) => filter === 'all' || submission.category === filter) && <StaffEmptyState
        type="payment"
        title={filter === 'all' ? 'No payment submissions yet.' : 'No submissions match this payment type.'}
        description="When someone submits a payment, it will appear here."
      />}
      {submissions.filter((submission) => !staff || filter === 'all' || submission.category === filter).map((submission) => (
        <article className="portal-card" key={submission.id}>
          <div className="item-heading">
            <div><strong>{submission.category} · PHP {submission.amount}</strong><span>{submission.member_number} · {submission.first_name} {submission.last_name} · Submitted {submission.created_at}</span></div>
            <span className={`status status-${submission.status}`}>{submission.status}</span>
          </div>
          <dl className="payment-facts">
            <div><dt>Amount submitted</dt><dd>PHP {submission.amount}</dd></div>
            <div><dt>Payment for</dt><dd>{submission.category === 'paluwagan' ? `Paluwagan · ${submission.cycle_name || 'Cycle unavailable'}` : submission.category === 'loan' ? `Loan · ${submission.loan_code || 'Loan unavailable'}` : 'Cooperative payment'}</dd></div>
            <div><dt>Reference number</dt><dd>{submission.reference_no || 'Not provided'}</dd></div>
          </dl>
          {submission.review_note && <p className="notice">Staff note: {submission.review_note}</p>}
          {!submission.has_screenshot && <p className="muted">No screenshot attached; review the reference number above.</p>}
          <div className="button-row">
            {submission.has_screenshot && <button className="button button-outline" type="button" onClick={async () => {
              try { await openProtectedImage(token, `/payment-submissions/${submission.id}/screenshot`) } catch (requestError) { setActionError(requestError.message) }
            }}>View payment screenshot</button>}
            {staff && submission.status === 'pending' && <>
              <button className="button button-primary" type="button" onClick={() => reviewSubmission(submission.id, 'approve')}>Verify received</button>
              <button className="button button-outline" type="button" onClick={() => reviewSubmission(submission.id, 'reject')}>Reject evidence</button>
            </>}
          </div>
        </article>
      ))}
    </section>
  )
}

const STAFF_NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'loans', label: 'Loans', icon: 'loans' },
  { id: 'reports', label: 'Reports', icon: 'reports' },
  { id: 'payments', label: 'Payment Submissions', icon: 'payments' },
  { id: 'cooperative', label: 'Daily Paluwagan', icon: 'cooperative' },
  { id: 'savings', label: 'Savings', icon: 'savings' },
  { id: 'members', label: 'Members', icon: 'members' },
]

const MEMBER_NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'loans', label: 'Loans', icon: 'loans' },
  { id: 'payments', label: 'Online Payments', icon: 'payments' },
  { id: 'cooperative', label: 'Daily Paluwagan', icon: 'cooperative' },
  { id: 'savings', label: 'Savings', icon: 'savings' },
]

const STAFF_PAGE_DETAILS = {
  dashboard: ['Dashboard', 'Manage cooperative services and member activity.'],
  loans: ['Loans', 'Review loan status and explore available loan offers.'],
  reports: ['Reports', 'View recorded cooperative totals and monthly activity.'],
  payments: ['Payment Submissions', 'Review submitted amounts, references, and payment evidence.'],
  cooperative: ['Daily Paluwagan', 'Members contribute the same amount each day. When everyone has contributed, the next person in payout order is ready to receive the pooled amount.'],
  savings: ['Savings', 'Record savings transactions.'],
  members: ['Members', 'Member directory and account status.'],
}

const MEMBER_PAGE_DETAILS = {
  dashboard: ['Dashboard', 'Your cooperative services, all in one place.'],
  loans: ['Loans', 'Review your loan documents, offers, and applications.'],
  payments: ['Online Payments', 'Submit payment details and review your payment evidence.'],
  cooperative: ['Daily Paluwagan', 'Members contribute the same amount each day. When everyone has contributed, the next person in payout order is ready to receive the pooled amount.'],
  savings: ['Savings', 'View your savings balance and transaction history.'],
}

function StaffIcon({ name }) {
  const paths = {
    dashboard: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
    loans: <><path d="M4 5.5h16M4 10h16M4 14.5h10" /><path d="M17 14v6m-3-3h6" /></>,
    reports: <><path d="M4 20V11m5 9V5m5 15v-7m5 7V3" /><path d="M2.5 20.5h19" /></>,
    payments: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18m-14 5h4" /></>,
    cooperative: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
    savings: <><path d="M19.5 9.5c-1.6-2.4-4.1-3.5-7.5-3.5-4.7 0-8 2.5-8 6s3.3 6 8 6c3.4 0 5.9-1.1 7.5-3.5" /><path d="M18 10h3v4h-3m-7-2h.01" /></>,
    members: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20v-1.5A5.5 5.5 0 0 1 9 13h1a5.5 5.5 0 0 1 5.5 5.5V20z" /><path d="M16 5.5a3 3 0 0 1 0 5.8m2 2a5 5 0 0 1 2.5 4.3V20" /></>,
  }
  return <svg className="staff-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function ServiceDashboard({ token, user, staff, selectedTab, setSelectedTab, refreshKey }) {
  const [memberCardOpen, setMemberCardOpen] = useState(false)
  const tabs = [
    { id: 'loans', label: 'Monthly loans' },
    { id: 'savings', label: 'Savings' },
    { id: 'cooperative', label: 'Daily Paluwagan' },
    { id: 'payments', label: staff ? 'Payment submissions' : 'Online payments' },
    ...(staff ? [{ id: 'members', label: 'Members' }, { id: 'reports', label: 'Reports' }] : []),
  ]

  return (
    <>
      <div className="staff-account-summary">
        <article className="staff-account-card">
          <span className="staff-account-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>
          </span>
          <span><small>Account</small><strong>{user.full_name}</strong></span>
        </article>
        <article className="staff-account-card">
          <span className="staff-account-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6z" /><path d="m9 12 2 2 4-4" /></svg>
          </span>
          <span><small>Role</small><strong>{user.role}</strong></span>
        </article>
        {!staff && user.member && <article className="staff-account-card">
          <span className="staff-account-icon"><StaffIcon name="members" /></span>
          <span><small>Member number</small><strong>{user.member.member_number}</strong></span>
        </article>}
      </div>
      {!staff && user.member && <div className="member-dashboard-actions">
        <button className="button button-outline" type="button" onClick={() => setMemberCardOpen(true)}>View / print my member ID</button>
      </div>}
      <nav className="staff-service-tabs" aria-label="Cooperative services">
        {tabs.map((tab) => (
          <button
            className={`staff-service-tab${selectedTab === tab.id ? ' active' : ''}`}
            type="button"
            key={tab.id}
            aria-current={selectedTab === tab.id ? 'page' : undefined}
            onClick={() => setSelectedTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {selectedTab === 'loans'
        ? <LoanPortal key="dashboard-loans" token={token} user={user} refreshKey={refreshKey} />
        : selectedTab === 'members'
          ? <MembersPortal key="dashboard-members" token={token} />
          : selectedTab === 'savings'
            ? <SavingsPortal key="dashboard-savings" token={token} user={user} refreshKey={refreshKey} />
            : selectedTab === 'cooperative'
              ? <CooperativePortal key="dashboard-cooperative" token={token} user={user} refreshKey={refreshKey} />
              : selectedTab === 'payments'
                ? <PaymentPortal key="dashboard-payments" token={token} user={user} refreshKey={refreshKey} />
                : <ReportsPortal key="dashboard-reports" token={token} refreshKey={refreshKey} />}
      {memberCardOpen && <MemberIdCardDialog token={token} memberId={null} onClose={() => setMemberCardOpen(false)} />}
    </>
  )
}

function StaffWorkspace({ token, user, section, setSection, refreshKey, onSignOut }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dashboardTab, setDashboardTab] = useState('loans')
  const staff = ['admin', 'officer'].includes(user.role)
  const navItems = staff ? STAFF_NAV_ITEMS : MEMBER_NAV_ITEMS
  const pageDetails = staff ? STAFF_PAGE_DETAILS : MEMBER_PAGE_DETAILS
  const [pageTitle, pageDescription] = pageDetails[section] || pageDetails.dashboard
  const initials = user.full_name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()

  function navigate(nextSection) {
    setSection(nextSection)
    setSidebarOpen(false)
  }

  return (
    <div className={`staff-layout${sidebarOpen ? ' sidebar-open' : ''}`}>
      {sidebarOpen && <button className="staff-sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <aside className="staff-sidebar" aria-label="Main navigation">
        <a className="staff-brand" href="/" aria-label="CoopWise home">
          <svg className="staff-brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M4 27C4 15 11 7 27 5c-1 14-8 22-21 22Z" fill="currentColor" />
            <path d="M8 27c4-7 9-12 16-17" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" />
            <path d="M5 28c1-5 4-9 9-12" fill="none" stroke="#74bd98" strokeLinecap="round" strokeWidth="3" />
          </svg>
          <span>Coop<span>Wise</span></span>
        </a>
        <nav className="staff-nav">
          {navItems.map((item) => (
            <button
              className={`staff-nav-item${section === item.id ? ' active' : ''}`}
              type="button"
              key={item.id}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => navigate(item.id)}
            >
              <StaffIcon name={item.icon} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <button className="staff-sign-out" type="button" onClick={onSignOut}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 17l5-5-5-5m5 5H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></svg>
          <span>Sign out</span>
        </button>
      </aside>
      <div className="staff-main">
        <header className="staff-topbar">
          <button className="staff-menu-toggle" type="button" aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="staff-topbar-label">{staff ? 'Cooperative management' : 'Member services'}</span>
          <div className="staff-topbar-actions">
            <span className="staff-notification-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>
            </span>
            <span className="staff-role">{user.role}</span>
            <span className="staff-avatar" aria-label={user.full_name}>{initials}</span>
          </div>
        </header>
        <section className={`staff-page-banner${section === 'dashboard' ? '' : ' staff-page-banner-module'}`}>
          {section !== 'dashboard' && <span className="staff-page-icon"><StaffIcon name={navItems.find((item) => item.id === section)?.icon || 'dashboard'} /></span>}
          <div className="staff-banner-copy">
            {section === 'dashboard' && <h1>Welcome, {user.full_name} 👋</h1>}
            {section !== 'dashboard' && <h1>{pageTitle}</h1>}
            <p>{section === 'dashboard' && staff ? 'Manage cooperative services and member activity.' : pageDescription}</p>
          </div>
          <span className="staff-banner-art" aria-hidden="true" />
        </section>
        <div className="staff-content">
          {section === 'dashboard'
            ? <ServiceDashboard token={token} user={user} staff={staff} selectedTab={dashboardTab} setSelectedTab={setDashboardTab} refreshKey={refreshKey} />
            : section === 'loans'
              ? <LoanPortal key="loans" token={token} user={user} refreshKey={refreshKey} standalone />
              : section === 'members'
                ? <MembersPortal key="members" token={token} standalone />
                : section === 'savings'
                  ? <SavingsPortal key="savings" token={token} user={user} refreshKey={refreshKey} standalone />
                  : section === 'cooperative'
                    ? <CooperativePortal key="cooperative" token={token} user={user} refreshKey={refreshKey} standalone />
                    : section === 'payments'
                      ? <PaymentPortal key="payments" token={token} user={user} refreshKey={refreshKey} standalone />
                      : <ReportsPortal key="reports" token={token} refreshKey={refreshKey} standalone />}
        </div>
        <footer className="staff-footer">CoopWise demo · This system records cooperative activity; it does not transfer money.</footer>
      </div>
    </div>
  )
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('coopwise_access_token'))
  const [user, setUser] = useState(null)
  const [authenticating, setAuthenticating] = useState(() => Boolean(sessionStorage.getItem('coopwise_access_token')))
  const [memberCardToken] = useState(() => new URLSearchParams(window.location.search).get('member_card') || '')
  const [mode, setMode] = useState('login')
  const [section, setSection] = useState('dashboard')
  const [message, setMessage] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!token || memberCardToken) return
    let active = true
    apiRequest('/me', { token })
      .then((result) => {
        if (!active) return
        setUser(result.user)
        setSection('dashboard')
        setAuthenticating(false)
      })
      .catch(() => {
        if (!active) return
        setAuthenticating(false)
        sessionStorage.removeItem('coopwise_access_token')
        setToken(null)
        setUser(null)
      })
    return () => { active = false }
  }, [token, memberCardToken])

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
        setSection('dashboard')
      }
    } catch (requestError) {
      setMessage(requestError.message)
      setFieldErrors(requestError.fields || {})
    } finally {
      setBusy(false)
    }
  }

  function signOut() {
    if (!window.confirm('Are you sure you want to sign out?')) return
    sessionStorage.removeItem('coopwise_access_token')
    setToken(null)
    setUser(null)
    setMode('login')
    setMessage('You have signed out.')
  }

  if (memberCardToken) return <MemberCardVerification verificationToken={memberCardToken} />

  return (
    <main className={`page-shell${user ? ' page-shell-staff' : ''}`}>
      {user ? (
        <StaffWorkspace token={token} user={user} section={section} setSection={setSection} refreshKey={refreshKey} onSignOut={signOut} />
      ) : (
        <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="CoopWise home">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 27C4 15 11 7 27 5c-1 14-8 22-21 22Z" fill="currentColor" /><path d="M8 27c4-7 9-12 16-17" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" /></svg>
          <span>Coop<span>Wise</span></span>
        </a>
        <span className="tagline">Cooperative services, made clear</span>
      </header>

      {authenticating ? (
        <section className="auth-loading" role="status" aria-live="polite">
          <span className="auth-loading-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M4 27C4 15 11 7 27 5c-1 14-8 22-21 22Z" fill="currentColor" /><path d="M8 27c4-7 9-12 16-17" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" /></svg>
          </span>
          <span>Loading your CoopWise workspace…</span>
        </section>
      ) : (
        <section className="auth-layout">
          <div className="intro">
            <div className="eyebrow">CoopWise cooperative services</div>
            <h1>Built around your cooperative.</h1>
            <p>Sign in to manage your loans, savings, Paluwagan contributions, and payment records.</p>
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
        </>
      )}
    </main>
  )
}

export default App
