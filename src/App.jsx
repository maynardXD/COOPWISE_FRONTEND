import { useEffect, useState } from 'react'
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
    const error = new Error(body.message || body.error || 'The request could not be completed.')
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

function AdminSearch({ token }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [error, setError] = useState('')
  const [selectedMember, setSelectedMember] = useState(null)

  async function search(event) {
    event.preventDefault()
    setError('')
    setResults(null)
    setSelectedMember(null)
    try {
      setResults(await apiRequest(`/admin/search?q=${encodeURIComponent(query.trim())}`, { token }))
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  return (
    <details className="portal-card">
      <summary>Search members, loans, and payment submissions</summary>
      <form className="inline-form" onSubmit={search}>
        <input aria-label="Search dashboard records" value={query} onChange={(event) => setQuery(event.target.value)} minLength="2" maxLength="100" placeholder="Member name, number, loan code, or reference" required />
        <button className="button button-primary" type="submit">Search</button>
      </form>
      <PortalMessage error>{error}</PortalMessage>
      {results && (
        <div className="search-results">
          <h3>Members</h3>
          {results.members.length ? (
            <div className="table-wrap"><table><thead><tr><th>Member #</th><th>Name</th><th>Phone</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
              <tbody>{results.members.map((member) => <tr key={member.id}>
                <td>{member.member_number}</td><td>{member.first_name} {member.last_name}</td><td>{member.contact_number || '—'}</td><td>{member.email || '—'}</td><td>{member.account_role}</td><td>{member.status}</td>
                <td><button className="text-button" type="button" onClick={() => setSelectedMember(member.id)}>View profile</button></td>
              </tr>)}</tbody>
            </table></div>
          ) : <p className="muted">No matching members.</p>}
          {selectedMember && results.members.filter((member) => member.id === selectedMember).map((member) => (
            <article className="portal-card" key={member.id}>
              <div className="item-heading"><strong>{member.first_name} {member.middle_name ? `${member.middle_name} ` : ''}{member.last_name}</strong><button className="button button-outline" type="button" onClick={() => setSelectedMember(null)}>Close profile</button></div>
              <p>Member #: {member.member_number} · Account: {member.account_role} · Status: {member.status}</p>
              <p>Phone: {member.contact_number || 'Not provided'} · Email: {member.email || 'Not provided'}</p>
              <p>Address: {member.address || 'Not provided'} · Date of birth: {member.birth_date || 'Not provided'}</p>
            </article>
          ))}
          <h3>Loans</h3>
          {results.loans.length ? results.loans.map((loan) => <p key={loan.id}>{loan.loan_code} · {loan.first_name} {loan.last_name} · {loan.loan_type_name} · PHP {loan.principal_amount} · {loan.status}</p>) : <p className="muted">No matching loans.</p>}
          <h3>Payment submissions</h3>
          {results.payments.length ? results.payments.map((payment) => <p key={payment.id}>#{payment.id} · {payment.member_number} · {payment.first_name} {payment.last_name} · {payment.category} · PHP {payment.amount} · {payment.status}{payment.reference_no ? ` · ${payment.reference_no}` : ''}</p>) : <p className="muted">No matching payment submissions.</p>}
        </div>
      )}
    </details>
  )
}

function LoanPortal({ token, user, refreshKey }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error, loading } = usePortalData(token, refreshKey, LOAN_ENDPOINTS)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [schedule, setSchedule] = useState(null)
  const products = data?.[0]?.products || []
  const loans = data?.[1]?.loans || []
  const payments = data?.[2]?.payments || []
  const readiness = data?.[3]?.readiness
  const readinessAvailable = data?.[3]?.available !== false
  const readinessSubmissions = data?.[3]?.submissions || []

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

  return (
    <section className="portal-section">
      <div className="section-heading">
        <div>
          <div className="eyebrow">Credit services</div>
          <h2>Monthly loans</h2>
          <p className="muted">Review your document status and explore available loan offers.</p>
        </div>
        <button className="button button-outline" type="button" onClick={refreshLoanData} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh status'}
        </button>
      </div>
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
                ? <p className="notice">Your documents are approved, but there are no active loan offers yet. Please check back later or contact cooperative staff.</p>
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
                        <label>Amount (PHP)<input name="amount" type="number" min="0.01" max={product.max_amount} step="0.01" required /></label>
                        <label>Term (months)<input name="term_months" type="number" min="1" max={product.max_term_months} required /></label>
                        <label className="full">Purpose<input name="purpose" maxLength="255" required /></label>
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

function MembersPortal({ token }) {
  return (
    <section className="portal-section">
      <h2>Member directory</h2>
      <p className="muted">Search member names, numbers, contact details, account role, and membership status.</p>
      <AdminSearch token={token} />
    </section>
  )
}

function SavingsPortal({ token, user, refreshKey }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error } = usePortalData(token, refreshKey, SAVINGS_ENDPOINTS)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const transactions = data?.[0]?.transactions || []
  const members = data?.[0]?.members || []
  const balance = data?.[0]?.balance

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

  return (
    <section className="portal-section">
      <h2>Savings</h2>
      {!staff && <div className="portal-card savings-balance"><span>Your available savings</span><strong>PHP {((balance || 0) / 100).toFixed(2)}</strong></div>}
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
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
      <h3>Transaction history</h3>
      {data && transactions.length === 0 && <p className="muted">No savings transactions recorded.</p>}
      {!!transactions.length && <div className="table-wrap"><table><thead><tr>
        <th>Date</th>{staff && <th>Member</th>}<th>Type</th><th>Amount</th><th>Balance after</th><th>Reference</th><th>Description</th>
      </tr></thead><tbody>{transactions.map((entry) => <tr key={entry.id}>
        <td>{entry.created_at}</td>{staff && <td>{entry.member_number} · {entry.first_name} {entry.last_name}</td>}
        <td>{entry.type}</td><td>PHP {entry.amount}</td><td>PHP {entry.balance_after}</td><td>{entry.reference_no}</td><td>{entry.description || '—'}</td>
      </tr>)}</tbody></table></div>}
    </section>
  )
}

function ReportsPortal({ token, refreshKey }) {
  const { data, error } = usePortalData(token, refreshKey, REPORT_ENDPOINTS)
  const report = data?.[0]
  return (
    <section className="portal-section">
      <h2>Reports</h2>
      <PortalMessage error>{error}</PortalMessage>
      {!report && !error && <p className="muted">Loading current figures…</p>}
      {report && <>
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

function PaymentPortal({ token, user, refreshKey }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error } = usePortalData(token, refreshKey, PAYMENT_ENDPOINTS)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
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
      <h2>Submit a payment</h2>
      <p className="muted">Pay with GCash, then upload a screenshot of the successful transfer or enter its transaction reference number. Staff will review the evidence; submission does not automatically confirm or post a payment.</p>
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
      <h3>{staff ? 'Payment evidence awaiting review' : 'Your payment submissions'}</h3>
      {data && submissions.length === 0 && <p className="muted">No payment submissions yet.</p>}
      {submissions.map((submission) => (
        <article className="portal-card" key={submission.id}>
          <div className="item-heading">
            <div><strong>{submission.category} · PHP {submission.amount}</strong><span>{submission.member_number} · {submission.first_name} {submission.last_name} · Submitted {submission.created_at}</span></div>
            <span className={`status status-${submission.status}`}>{submission.status}</span>
          </div>
          {(submission.loan_code || submission.cycle_name) && <p>{submission.loan_code || submission.cycle_name}</p>}
          {submission.reference_no && <p>Reference: {submission.reference_no}</p>}
          {submission.review_note && <p className="notice">Staff note: {submission.review_note}</p>}
          <div className="button-row">
            {submission.has_screenshot && <button className="button button-outline" type="button" onClick={async () => {
              try { await openProtectedImage(token, `/payment-submissions/${submission.id}/screenshot`) } catch (requestError) { setActionError(requestError.message) }
            }}>View screenshot</button>}
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
    if (!window.confirm('Are you sure you want to sign out?')) return
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
          <div className="eyebrow">{['admin', 'officer'].includes(user.role) ? 'Staff workspace' : 'Member portal'}</div>
          <h1>Welcome, {user.full_name}</h1>
          <p className="muted">{['admin', 'officer'].includes(user.role) ? 'Manage cooperative services and member activity.' : 'Your cooperative services, all in one place.'}</p>
          <div className="profile-card">
            <div><span>Account</span><strong>{user.full_name}</strong></div>
            <div><span>Role</span><strong>{user.role}</strong></div>
            {user.member && <div><span>Member number</span><strong>{user.member.member_number}</strong></div>}
          </div>
          <nav className="portal-tabs" aria-label="Cooperative services">
            <button className={section === 'loans' ? 'tab active' : 'tab'} type="button" onClick={() => setSection('loans')}>Monthly loans</button>
            {['admin', 'officer'].includes(user.role) && <button className={section === 'members' ? 'tab active' : 'tab'} type="button" onClick={() => setSection('members')}>Members</button>}
            <button className={section === 'savings' ? 'tab active' : 'tab'} type="button" onClick={() => setSection('savings')}>Savings</button>
            <button className={section === 'cooperative' ? 'tab active' : 'tab'} type="button" onClick={() => setSection('cooperative')}>Daily Paluwagan</button>
            <button className={section === 'payments' ? 'tab active' : 'tab'} type="button" onClick={() => setSection('payments')}>Online payments</button>
            {['admin', 'officer'].includes(user.role) && <button className={section === 'reports' ? 'tab active' : 'tab'} type="button" onClick={() => setSection('reports')}>Reports</button>}
          </nav>
          {section === 'loans'
            ? <LoanPortal key="loans" token={token} user={user} refreshKey={refreshKey} />
            : section === 'members'
              ? <MembersPortal key="members" token={token} />
              : section === 'savings'
                ? <SavingsPortal key="savings" token={token} user={user} refreshKey={refreshKey} />
                : section === 'cooperative'
                  ? <CooperativePortal key="cooperative" token={token} user={user} refreshKey={refreshKey} />
                  : section === 'payments'
                    ? <PaymentPortal key="payments" token={token} user={user} refreshKey={refreshKey} />
                    : <ReportsPortal key="reports" token={token} refreshKey={refreshKey} />}
          <button className="button button-outline sign-out" onClick={signOut} type="button">Sign out</button>
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
    </main>
  )
}

export default App
