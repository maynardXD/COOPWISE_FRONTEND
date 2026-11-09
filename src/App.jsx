import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost/COOPWISE/LavaLust-COOPWISE/api').replace(/\/+$/, '')
const TODAY = new Date().toISOString().slice(0, 10)
const CURRENT_YEAR = Number(TODAY.slice(0, 4))
const LOAN_ENDPOINTS = ['/loan-products', '/loans', '/payments', '/loan-readiness', '/loans/eligibility']
const PAYMENT_ENDPOINTS = ['/loans', '/cooperative/cycles', '/share-capital', '/checkout-transactions', '/savings']
const SHARE_CAPITAL_ENDPOINTS = ['/share-capital', '/cooperative/finance']
const REPORT_ENDPOINTS = ['/reports', '/cooperative/finance', '/cooperative/surplus']
const POLICY_ENDPOINTS = ['/cooperative/policies']
const PORTAL_CACHE_MAX_AGE_MS = 15_000
const portalDataCache = new Map()
let portalCacheRevision = 0
let googleChartsPromise = null
let googleIdentityPromise = null
let turnstilePromise = null

function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark'
  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={onToggle}
      aria-label={`Switch to ${dark ? 'day' : 'night'} mode`}
      title={`Switch to ${dark ? 'day' : 'night'} mode`}
      aria-pressed={dark}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {dark
          ? <><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>
          : <><path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z" /></>}
      </svg>
      <span>{dark ? 'Day' : 'Night'} mode</span>
    </button>
  )
}

function loadExternalScript(src, ready) {
  if (ready()) return Promise.resolve()
  const existing = document.querySelector(`script[src="${src}"]`)
  return new Promise((resolve, reject) => {
    const script = existing || document.createElement('script')
    const onLoad = () => ready() ? resolve() : reject(new Error('The external service did not initialize.'))
    const onError = () => {
      script.remove()
      reject(new Error('The external service could not be loaded. Check your connection and try again.'))
    }
    script.addEventListener('load', onLoad, { once: true })
    script.addEventListener('error', onError, { once: true })
    if (!existing) {
      script.src = src
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    }
  })
}

function loadGoogleCharts() {
  if (!googleChartsPromise) {
    googleChartsPromise = loadExternalScript(
      'https://www.gstatic.com/charts/loader.js',
      () => Boolean(window.google?.charts?.load),
    ).then(() => new Promise((resolve) => {
      window.google.charts.load('current', { packages: ['corechart'] })
      window.google.charts.setOnLoadCallback(resolve)
    })).catch((error) => {
      googleChartsPromise = null
      throw error
    })
  }
  return googleChartsPromise
}

function loadGoogleIdentity() {
  if (!googleIdentityPromise) {
    googleIdentityPromise = loadExternalScript(
      'https://accounts.google.com/gsi/client',
      () => Boolean(window.google?.accounts?.id),
    ).catch((error) => {
      googleIdentityPromise = null
      throw error
    })
  }
  return googleIdentityPromise
}

function loadTurnstile() {
  if (!turnstilePromise) {
    turnstilePromise = loadExternalScript(
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      () => Boolean(window.turnstile?.render),
    ).catch((error) => {
      turnstilePromise = null
      throw error
    })
  }
  return turnstilePromise
}

function invalidatePortalDataCache() {
  portalCacheRevision += 1
  portalDataCache.clear()
}

function portalCacheKey(token, endpoint) {
  return `${token || 'anonymous'}:${endpoint}`
}

function readPortalCache(token, endpoints) {
  const cached = endpoints.map((endpoint) => portalDataCache.get(portalCacheKey(token, endpoint)))
  if (!cached.some(Boolean)) return null
  return {
    data: cached.map((entry) => entry?.data ?? null),
    fresh: cached.every((entry) => entry && Date.now() - entry.savedAt < PORTAL_CACHE_MAX_AGE_MS),
  }
}

async function apiRequest(path, { token, ...options } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  let resolvedResponse = response
  if (response.status === 401 && token) {
    const refreshToken = sessionStorage.getItem('coopwise_refresh_token')
    if (!refreshToken) {
      expireSession()
    } else {
      const accessToken = await refreshSession(refreshToken)
      if (accessToken) {
        resolvedResponse = await fetch(`${API_BASE}${path}`, {
          ...options,
          headers: {
            ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
            Authorization: `Bearer ${accessToken}`,
            ...options.headers,
          },
        })
        if (resolvedResponse.status === 401) expireSession()
      }
    }
  }
  const body = await resolvedResponse.json().catch(() => ({}))
  if (!resolvedResponse.ok) {
    const retryAfter = Number(body.retry_after || 0)
    const message = resolvedResponse.status === 429 && retryAfter > 0
      ? `Too many requests. Please wait ${retryAfter} seconds before trying again.`
      : body.message || body.error || `Request failed (${resolvedResponse.status}).`
    const error = new Error(message)
    error.fields = body.errors || {}
    error.status = resolvedResponse.status
    error.retryAfter = retryAfter
    throw error
  }
  return body
}

let refreshRequest = null

function expireSession() {
  sessionStorage.removeItem('coopwise_access_token')
  sessionStorage.removeItem('coopwise_refresh_token')
  window.dispatchEvent(new Event('coopwise:session-expired'))
}

function refreshSession(refreshToken) {
  if (!refreshRequest) {
    refreshRequest = fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) expireSession()
          const error = new Error(body.message || `Session refresh failed (${response.status}).`)
          error.status = response.status
          throw error
        }
        const tokens = body.tokens
        if (!tokens?.access_token || !tokens?.refresh_token) {
          throw new Error('The server returned an invalid session refresh response.')
        }
        sessionStorage.setItem('coopwise_access_token', tokens.access_token)
        sessionStorage.setItem('coopwise_refresh_token', tokens.refresh_token)
        return tokens.access_token
      })
      .finally(() => { refreshRequest = null })
  }
  return refreshRequest
}

function TurnstileWidget({ siteKey, action, resetKey, onToken, onLoadError }) {
  const containerRef = useRef(null)
  const tokenCallback = useRef(onToken)
  const errorCallback = useRef(onLoadError)

  useEffect(() => { tokenCallback.current = onToken }, [onToken])
  useEffect(() => { errorCallback.current = onLoadError }, [onLoadError])

  useEffect(() => {
    let active = true
    let widgetId = null
    const container = containerRef.current
    loadTurnstile()
      .then(() => {
        if (!active || !container) return
        widgetId = window.turnstile.render(container, {
          sitekey: siteKey,
          action,
          theme: 'auto',
          callback: (token) => tokenCallback.current(token),
          'expired-callback': () => tokenCallback.current(''),
          'error-callback': () => {
            tokenCallback.current('')
            errorCallback.current('The security check could not load. Refresh the page and try again.')
          },
        })
      })
      .catch((error) => {
        if (active) errorCallback.current(error.message)
      })
    return () => {
      active = false
      tokenCallback.current('')
      if (widgetId !== null) window.turnstile?.remove(widgetId)
    }
  }, [action, resetKey, siteKey])

  return <div ref={containerRef} className="turnstile-widget" />
}

function GoogleSignInButton({ clientId, disabled, onCredential, onLoadError }) {
  const containerRef = useRef(null)
  const credentialCallback = useRef(onCredential)
  const errorCallback = useRef(onLoadError)

  useEffect(() => { credentialCallback.current = onCredential }, [onCredential])
  useEffect(() => { errorCallback.current = onLoadError }, [onLoadError])

  useEffect(() => {
    let active = true
    const container = containerRef.current
    loadGoogleIdentity()
      .then(() => {
        if (!active || !container) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response?.credential) credentialCallback.current(response.credential)
          },
        })
        window.google.accounts.id.renderButton(container, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          width: 280,
        })
      })
      .catch((error) => {
        if (active) errorCallback.current(error.message)
      })
    return () => {
      active = false
      if (container) container.replaceChildren()
    }
  }, [clientId])

  return <div className={`google-signin-button${disabled ? ' disabled' : ''}`} aria-disabled={disabled} ref={containerRef} />
}

async function openProtectedImage(token, path) {
  const preview = window.open('about:blank', '_blank')
  if (!preview) throw new Error('Allow pop-ups to view this private image.')
  try {
    const response = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    let imageResponse = response
    if (response.status === 401) {
      const refreshToken = sessionStorage.getItem('coopwise_refresh_token')
      if (!refreshToken) {
        expireSession()
      } else {
        const accessToken = await refreshSession(refreshToken)
        if (accessToken) {
          imageResponse = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } })
          if (imageResponse.status === 401) expireSession()
        }
      }
    }
    if (!imageResponse.ok) {
      const body = await imageResponse.json().catch(() => ({}))
      throw new Error(body.message || body.error || 'The image could not be opened.')
    }
    const objectUrl = URL.createObjectURL(await imageResponse.blob())
    preview.location.href = objectUrl
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000)
  } catch (error) {
    preview.close()
    throw error
  }
}

function usePortalData(token, refreshKey, endpoints) {
  const [data, setData] = useState(() => readPortalCache(token, endpoints)?.data || null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(() => !readPortalCache(token, endpoints))
  const previousData = useRef(data)

  useEffect(() => {
    previousData.current = data
  }, [data])

  useEffect(() => {
    let active = true
    const requestRevision = portalCacheRevision
    const cached = readPortalCache(token, endpoints)
    if (cached?.fresh) {
      Promise.resolve().then(() => {
        if (active) {
          setData(cached.data)
          setError('')
          setLoading(false)
        }
      })
      return () => { active = false }
    }

    Promise.all(endpoints.map(async (path) => {
      try {
        const result = await apiRequest(path, { token })
        if (requestRevision === portalCacheRevision) {
          portalDataCache.set(portalCacheKey(token, path), { data: result, savedAt: Date.now() })
        }
        return { result }
      } catch (requestError) {
        return { error: `${path}: ${requestError.message}` }
      }
    }))
      .then((results) => {
      if (active && requestRevision === portalCacheRevision) {
          setData(results.map((item, index) => item.result ?? previousData.current?.[index] ?? null))
          setError(results.filter((item) => item.error).map((item) => item.error).join(' · '))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [token, refreshKey, endpoints])

  const refreshEndpoint = useCallback(async (endpoint) => {
    const index = endpoints.indexOf(endpoint)
    if (index < 0) return
    const requestRevision = portalCacheRevision
    const result = await apiRequest(endpoint, { token })
    if (requestRevision !== portalCacheRevision) return
    portalDataCache.set(portalCacheKey(token, endpoint), { data: result, savedAt: Date.now() })
    setData((current) => {
      const updated = [...(current || endpoints.map(() => null))]
      updated[index] = result
      return updated
    })
    setError((current) => current
      .split(' · ')
      .filter((message) => message && !message.startsWith(`${endpoint}:`))
      .join(' · '))
  }, [endpoints, token])

  return { data, error, loading, refreshEndpoint }
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

async function createSavingsLedgerPdf(ledger) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const margin = 12
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const columnWidths = [29, 41, 95, 34, 34, 40]
  const headers = ['Date', 'Reference', 'Description', 'Credit', 'Debit', 'Balance']
  const safeText = (value) => String(value ?? '-').replace(/[^\x20-\x7E]/g, ' ')
  const columnX = columnWidths.map((_, index) =>
    margin + columnWidths.slice(0, index).reduce((total, width) => total + width, 0)
  )

  function drawPageHeader() {
    pdf.setTextColor(25, 68, 51)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(16)
    pdf.text('CoopWise Savings Transaction Statement', margin, 16)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(9)
    pdf.text(`Member: ${safeText(ledger.member.full_name)}  |  Member number: ${safeText(ledger.member.member_number)}`, margin, 23)
    pdf.text(`Status: ${safeText(ledger.member.status)}  |  Period: ${ledger.period.from} to ${ledger.period.to}  |  Generated: ${ledger.generated_at}`, margin, 29)

    const summary = [
      ['Opening balance', ledger.opening_balance],
      ['Total credits', ledger.deposits_total],
      ['Total withdrawals', ledger.withdrawals_total],
      ['Closing balance', ledger.closing_balance],
    ]
    const summaryWidth = (pageWidth - margin * 2) / summary.length
    summary.forEach(([label, amount], index) => {
      const x = margin + index * summaryWidth
      pdf.setFillColor(239, 247, 242)
      pdf.roundedRect(x, 34, summaryWidth - 3, 13, 2, 2, 'F')
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(8)
      pdf.setTextColor(92, 113, 102)
      pdf.text(label, x + 3, 39)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(10)
      pdf.setTextColor(25, 68, 51)
      pdf.text(formatPesos(amount), x + 3, 45)
    })

    pdf.setFillColor(228, 241, 234)
    pdf.rect(margin, 52, pageWidth - margin * 2, 8, 'F')
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(8)
    pdf.setTextColor(44, 75, 59)
    headers.forEach((header, index) => pdf.text(header, columnX[index] + 2, 57))
    return 62
  }

  let y = drawPageHeader()
  const rows = [
    ['Opening balance', '-', 'Balance at start of period', '-', '-', formatPesos(ledger.opening_balance)],
    ...ledger.transactions.map((transaction) => [
      transaction.created_at,
      transaction.reference_no,
      transaction.description || (transaction.type === 'deposit' ? 'Member balance credit' : 'Member balance withdrawal'),
      transaction.type === 'deposit' ? formatPesos(transaction.amount) : '-',
      transaction.type === 'withdrawal' ? formatPesos(transaction.amount) : '-',
      formatPesos(transaction.balance_after),
    ]),
  ]
  if (!ledger.transactions.length) rows.push(['-', '-', 'No savings transactions in this period.', '-', '-', formatPesos(ledger.closing_balance)])

  rows.forEach((row) => {
    const wrapped = row.map((value, index) => pdf.splitTextToSize(safeText(value), columnWidths[index] - 4))
    const rowHeight = Math.max(8, ...wrapped.map((lines) => lines.length * 3.8 + 4))
    if (y + rowHeight > pageHeight - 14) {
      pdf.addPage()
      y = drawPageHeader()
    }
    pdf.setDrawColor(224, 233, 228)
    pdf.line(margin, y + rowHeight, pageWidth - margin, y + rowHeight)
    wrapped.forEach((lines, index) => {
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(7.5)
      pdf.setTextColor(38, 57, 47)
      const x = index >= 3
        ? columnX[index] + columnWidths[index] - 2
        : columnX[index] + 2
      pdf.text(lines, x, y + 4, index >= 3 ? { align: 'right' } : undefined)
    })
    y += rowHeight
  })

  const pages = pdf.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page)
    pdf.setFontSize(7)
    pdf.setTextColor(115, 128, 120)
    pdf.text(`This statement reflects CoopWise records. Page ${page} of ${pages}.`, margin, pageHeight - 6)
  }
  const dataUri = pdf.output('datauristring')
  return dataUri.slice(dataUri.indexOf(',') + 1)
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
  const [emailNotice, setEmailNotice] = useState('')
  const [emailError, setEmailError] = useState('')
  const [emailSending, setEmailSending] = useState(false)
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
    setEmailNotice('')
    setEmailError('')
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

  async function emailLedgerPdf() {
    if (!ledger || emailSending) return
    setEmailNotice('')
    setEmailError('')
    setEmailSending(true)
    try {
      const pdfBase64 = await createSavingsLedgerPdf(ledger)
      const result = await apiRequest('/savings/ledger/email', {
        token,
        method: 'POST',
        body: JSON.stringify({
          pdf_base64: pdfBase64,
          ...(member ? { member_id: member.id } : {}),
        }),
      })
      setEmailNotice(result.message)
    } catch (requestError) {
      setEmailError(requestError.message)
    } finally {
      setEmailSending(false)
    }
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
          <button className="button button-outline" type="button" onClick={emailLedgerPdf} disabled={!ledger || loading || emailSending}>
            {emailSending ? 'Emailing PDF…' : member ? "Email PDF to member's registered email" : 'Email PDF to my account'}
          </button>
        </div>
        <div className="no-print"><PortalMessage error>{emailError}</PortalMessage><PortalMessage>{emailNotice}</PortalMessage></div>
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
            <div><span>Total credits</span><strong>{formatPesos(ledger.deposits_total)}</strong></div>
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
                    <td>{transaction.description || (transaction.type === 'deposit' ? 'Member balance credit' : 'Member balance withdrawal')}</td>
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

function MemberCardVerification({ verificationToken, theme, onToggleTheme }) {
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
      <header className="topbar">
        <a className="brand" href="/" aria-label="CoopWise home">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 27C4 15 11 7 27 5c-1 14-8 22-21 22Z" fill="currentColor" /><path d="M8 27c4-7 9-12 16-17" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" /></svg>
          <span>Coop<span>Wise</span></span>
        </a>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </header>
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

function LoanComparison({ products }) {
  const [comparison, setComparison] = useState({ amount: '', term: '' })
  return <section className="loan-comparison">
    <h3>Compare estimated loan costs</h3>
    <p className="muted">Use one amount and term to compare available offers on the same basis. This estimate uses flat interest on the original principal; it is not an approval or a published universal rate.</p>
    <div className="form-grid loan-comparison-inputs">
      <label>Amount to compare (PHP)<input type="number" min="0.01" step="0.01" value={comparison.amount} onChange={(event) => setComparison({ ...comparison, amount: event.target.value })} /></label>
      <label>Term to compare (months)<input type="number" min="1" step="1" value={comparison.term} onChange={(event) => setComparison({ ...comparison, term: event.target.value })} /></label>
    </div>
    <div className="table-wrap"><table>
      <thead><tr><th>Offer</th><th>Monthly rate</th><th>Limits</th><th>Estimated interest</th><th>Total repayment</th><th>Installment estimate</th></tr></thead>
      <tbody>{products.map((product) => {
        const amountCents = Math.round(Number(comparison.amount) * 100)
        const termMonths = Number(comparison.term)
        const fits = amountCents > 0 && amountCents <= Math.round(Number(product.max_amount) * 100)
          && Number.isInteger(termMonths) && termMonths > 0 && termMonths <= Number(product.max_term_months)
        const rows = fits ? buildLoanSchedulePreview(comparison.amount, comparison.term, product.interest_rate) : null
        if (!rows) return <tr key={product.id}><td>{product.name}</td><td>{product.interest_rate}%</td><td>Up to {formatPesos(product.max_amount)} · {product.max_term_months} months</td><td colSpan="3">Enter an amount and term within this offer’s limits.</td></tr>
        const interest = rows.reduce((total, row) => total + Number(row.interest_due), 0)
        const total = rows.reduce((sum, row) => sum + Number(row.total_due), 0)
        return <tr key={product.id}><td>{product.name}</td><td>{product.interest_rate}%</td><td>Up to {formatPesos(product.max_amount)} · {product.max_term_months} months</td><td>{formatPesos(interest)}</td><td>{formatPesos(total)}</td><td>{formatPesos(rows[0].total_due)} × {rows.length}</td></tr>
      })}</tbody>
    </table></div>
  </section>
}

function LoanPortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [loansPage, setLoansPage] = useState(1)
  const [paymentsPage, setPaymentsPage] = useState(1)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const endpoints = useMemo(() => LOAN_ENDPOINTS.map((path) => {
    if (path === '/loans') return `${path}?page=${loansPage}&per_page=25`
    if (path === '/payments') return `${path}?page=${paymentsPage}&per_page=25`
    return path
  }), [loansPage, paymentsPage])
  const { data, error, loading, refreshEndpoint } = usePortalData(token, refreshKey, endpoints)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [schedule, setSchedule] = useState(null)
  const [applicationInputs, setApplicationInputs] = useState({})
  const [staffLoanTab, setStaffLoanTab] = useState(null)
  const products = data?.[0]?.products || []
  const loans = data?.[1]?.loans || []
  const payments = data?.[2]?.payments || []
  const readiness = data?.[3]?.readiness
  const eligibility = data?.[4]?.eligibility
  const readinessAvailable = data?.[3]?.available !== false
  const readinessSubmissions = data?.[3]?.submissions || []
  const pendingLoanApplications = loans.filter((loan) => loan.status === 'pending')
  const pendingLoanCount = data?.[1]?.pending_count ?? pendingLoanApplications.length
  const activeStaffLoanTab = staffLoanTab || (
    readinessSubmissions.length ? 'documents' : pendingLoanCount ? 'applications' : 'offers'
  )
  const productLoadFailed = error.includes('/loan-products:')

  useEffect(() => {
    if (staff) return undefined
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [staff])

  useEffect(() => {
    if (staff || !eligibility || eligibility.eligible
      || eligibility.membership_elapsed_seconds >= eligibility.criteria.membership_required_seconds) {
      return undefined
    }
    const timer = window.setInterval(() => {
      refreshEndpoint('/loans/eligibility').catch((requestError) => setActionError(requestError.message))
    }, 5000)
    return () => window.clearInterval(timer)
  }, [eligibility, refreshEndpoint, staff])

  const membershipElapsedSeconds = eligibility
    ? Math.min(
      eligibility.criteria.membership_required_seconds,
      eligibility.membership_elapsed_seconds + Math.max(0, Math.floor(clockNow / 1000) - eligibility.membership_checked_at),
    )
    : 0
  const membershipRequiredSeconds = eligibility?.criteria.membership_required_seconds || 0
  const formatSimulationTime = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

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
          <h2>Loans</h2>
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

      {staff && <nav className="loan-subtabs" aria-label="Loan management sections">
        <button className={`loan-subtab${activeStaffLoanTab === 'offers' ? ' active' : ''}`} type="button" aria-current={activeStaffLoanTab === 'offers' ? 'page' : undefined} onClick={() => setStaffLoanTab('offers')}>Loan offers</button>
        <button className={`loan-subtab${activeStaffLoanTab === 'documents' ? ' active' : ''}`} type="button" aria-current={activeStaffLoanTab === 'documents' ? 'page' : undefined} onClick={() => setStaffLoanTab('documents')}>
          Document reviews
          {readinessSubmissions.length > 0 && <span className="loan-review-badge" aria-label={`${readinessSubmissions.length} pending document reviews`}>{readinessSubmissions.length}</span>}
        </button>
        <button className={`loan-subtab${activeStaffLoanTab === 'applications' ? ' active' : ''}`} type="button" aria-current={activeStaffLoanTab === 'applications' ? 'page' : undefined} onClick={() => setStaffLoanTab('applications')}>
          Applications
          {pendingLoanCount > 0 && <span className="loan-review-badge" aria-label={`${pendingLoanCount} loan applications awaiting review`}>{pendingLoanCount}</span>}
        </button>
      </nav>}

      {!loading && staff && activeStaffLoanTab === 'documents' && (
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
      {!loading && staff && activeStaffLoanTab === 'offers' && (
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
      )}
      {!loading && !staff && (
        <>
          {eligibility && <article className="portal-card loan-eligibility-card">
            <h3>Loan eligibility check</h3>
            <p>{eligibility.eligible
              ? `You may apply for up to ${formatPesos(eligibility.max_eligible_amount)}. Staff still review every application.`
              : 'You are not currently eligible to apply. Meeting these requirements allows an application; it does not guarantee loan approval.'}</p>
            <dl className="offer-facts">
              <div><dt>Paid-up share capital</dt><dd>{formatPesos(eligibility.paid_up_share_capital)} / {formatPesos(eligibility.criteria.minimum_paid_up_share_capital)} minimum</dd></div>
              <div><dt>Simulated membership</dt><dd>{formatSimulationTime(membershipElapsedSeconds)} / {formatSimulationTime(membershipRequiredSeconds)}</dd></div>
              <div><dt>Savings balance</dt><dd>{formatPesos(eligibility.savings_balance)} / {formatPesos(eligibility.criteria.minimum_savings_balance)} minimum</dd></div>
              <div><dt>Outstanding loan balance</dt><dd>{formatPesos(eligibility.active_loan_balance)}</dd></div>
            </dl>
            {eligibility.reasons?.length > 0 && <ul className="member-order">{eligibility.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
            <small>Classroom simulation: each required membership day passes in 6 seconds, so the default 30-day waiting period takes 3 minutes. Share capital is not deducted when a loan is approved.</small>
          </article>}
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
                      <div><dt>Product maximum</dt><dd>{formatPesos(product.max_amount)}</dd></div>
                      <div><dt>Your current limit</dt><dd>{formatPesos(Math.min(Number(product.max_amount), Number(eligibility?.max_eligible_amount || 0)))}</dd></div>
                      <div><dt>Maximum term</dt><dd>{product.max_term_months} months</dd></div>
                    </dl>
                    <details className="offer-application">
                      <summary>Apply for this offer</summary>
                      {!eligibility?.eligible && <p className="notice">You cannot submit an application yet. Review the eligibility reasons above.</p>}
                      <form className="form-grid" onSubmit={(event) => submit(event, '/loans', 'POST', 'Loan application submitted.')}>
                        <input type="hidden" name="loan_type_id" value={product.id} />
                        <label>Amount (PHP)<input name="amount" type="number" min="0.01" max={Math.min(Number(product.max_amount), Number(eligibility?.max_eligible_amount || 0))} step="0.01" required disabled={!eligibility?.eligible} onChange={(event) => setApplicationInputs({ ...applicationInputs, [product.id]: { ...applicationInputs[product.id], amount: event.target.value } })} /></label>
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
                        <button className="button button-primary" type="submit" disabled={!eligibility?.eligible}>Submit application for staff review</button>
                      </form>
                    </details>
                  </article>
                ))}</div>}
              {products.length > 1 && <LoanComparison products={products} />}
            </section>
          )}
        </>
      )}

      {!loading && (!staff || activeStaffLoanTab === 'applications') && <>
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
          {loan.review_note && <p className="notice">Review note: {loan.review_note}</p>}
          <div className="button-row">
            {loan.status === 'approved' || loan.status === 'active'
              ? <button className="button button-outline" type="button" onClick={() => showSchedule(loan.id)}>View schedule</button>
              : null}
            {staff && loan.status === 'pending' && <>
              <button className="button button-primary" type="button" onClick={() => reviewLoan(loan.id, 'approve')}>Approve</button>
              <button className="button button-outline" type="button" onClick={() => reviewLoan(loan.id, 'reject')}>Reject</button>
            </>}
          </div>
        </article>
      ))}
      {data?.[1]?.pagination && <div className="pagination-controls" aria-label="Loan history pages">
        <button className="button button-outline" type="button" disabled={loansPage <= 1 || loading} onClick={() => setLoansPage((page) => page - 1)}>Previous</button>
        <span>Page {loansPage}</span>
        <button className="button button-outline" type="button" disabled={!data[1].pagination.has_more || loading} onClick={() => setLoansPage((page) => page + 1)}>Next</button>
      </div>}
      {staff && <details className="portal-card"><summary>Recent payments</summary>
        {payments.length ? <div className="table-wrap"><table><thead><tr><th>Loan</th><th>Member</th><th>Total</th><th>Principal</th><th>Interest</th><th>Method</th><th>Date</th></tr></thead>
          <tbody>{payments.map((payment) => <tr key={payment.id}><td>{payment.loan_code}</td><td>{payment.first_name} {payment.last_name}</td><td>{formatPesos(payment.amount_paid)}</td><td>{payment.breakdown_recorded ? formatPesos(payment.principal_paid) : 'Legacy — not split'}</td><td>{payment.breakdown_recorded ? formatPesos(payment.interest_paid) : 'Legacy — not split'}</td><td>{payment.payment_method}</td><td>{payment.payment_date}</td></tr>)}</tbody>
        </table></div> : <p className="muted">No payments recorded.</p>}
        {data?.[2]?.pagination && <div className="pagination-controls" aria-label="Loan payment pages">
          <button className="button button-outline" type="button" disabled={paymentsPage <= 1 || loading} onClick={() => setPaymentsPage((page) => page - 1)}>Previous</button>
          <span>Page {paymentsPage}</span>
          <button className="button button-outline" type="button" disabled={!data[2].pagination.has_more || loading} onClick={() => setPaymentsPage((page) => page + 1)}>Next</button>
        </div>}
      </details>}
      </>}
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
    </section>
  )
}

function CooperativePortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [contributionPage, setContributionPage] = useState(1)
  const [payoutPage, setPayoutPage] = useState(1)
  const endpoints = useMemo(() => [
    `/cooperative/cycles?contribution_page=${contributionPage}&payout_page=${payoutPage}&per_page=50`
  ], [contributionPage, payoutPage])
  const { data, error, loading } = usePortalData(token, refreshKey, endpoints)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [draftCycleId, setDraftCycleId] = useState('')
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

  async function enrollMembers(event) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    const member_ids = Array.from(form.elements.member_ids.selectedOptions, (option) => option.value)
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/cooperative/cycles/members', {
        token,
        method: 'POST',
        body: JSON.stringify({ cycle_id: values.get('cycle_id'), member_ids }),
      })
      setNotice(result.message)
      form.reset()
      setDraftCycleId('')
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return (
    <section className="portal-section">
      {!standalone && <>
        <h2>Daily rotating savings (Paluwagan)</h2>
        <p className="muted">Members pay their daily contribution through Xendit. Once everyone has paid, the next person in the randomized order is ready for the pooled payout. Staff confirm the simulated payout, which is then added to that member’s available balance.</p>
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
            <summary>Enroll multiple members and randomize payout order</summary>
            <form className="form-grid" onSubmit={enrollMembers}>
              <label>Draft cycle<select name="cycle_id" required value={draftCycleId} onChange={(event) => setDraftCycleId(event.target.value)}>
                <option value="">Select a cycle</option>
                {cycles.filter((cycle) => cycle.status === 'draft').map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}
              </select></label>
              <label className="full">Members<select name="member_ids" multiple required size={Math.min(Math.max(members.length, 3), 8)}>
                {members.filter((member) => !cycles.find((cycle) => String(cycle.id) === draftCycleId)?.members.some((enrolled) => Number(enrolled.member_id) === Number(member.id))).map((member) => <option key={member.id} value={member.id}>{member.member_number} · {member.first_name} {member.last_name}</option>)}
              </select><small>Hold Ctrl (Windows) or Command (Mac) while clicking to select multiple members. Their payout order is randomized by the server.</small></label>
              <button className="button button-primary" type="submit">Add selected members and randomize</button>
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
          {cycle.ready_payout && (
            <div className="payout-callout">
              <strong>Pooled payout ready: PHP {cycle.ready_payout.amount}</strong>
              <span>Recipient: {cycle.ready_payout.first_name} {cycle.ready_payout.last_name} (order {cycle.ready_payout.payout_order})</span>
              {staff && <button className="button button-primary" type="button" onClick={() => changeCycle('/cooperative/payouts/mark-paid', { payout_id: cycle.ready_payout.id }, 'Payout marked paid and added to the member balance.')}>Confirm payout paid</button>}
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
        {cyclesData.contributions_pagination && <div className="pagination-controls" aria-label="Paluwagan contribution pages">
          <button className="button button-outline" type="button" disabled={contributionPage <= 1 || loading} onClick={() => setContributionPage((page) => page - 1)}>Previous</button>
          <span>Page {contributionPage}</span>
          <button className="button button-outline" type="button" disabled={!cyclesData.contributions_pagination.has_more || loading} onClick={() => setContributionPage((page) => page + 1)}>Next</button>
        </div>}
        <h3>Payout history</h3>
        {cyclesData.payouts.length ? <div className="table-wrap"><table><thead><tr><th>Cycle</th><th>Recipient</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>{cyclesData.payouts.map((item) => <tr key={item.id}><td>{item.cycle_name}</td><td>{item.first_name} {item.last_name}</td><td>{item.payout_date}</td><td>PHP {item.amount}</td><td>{item.status}</td></tr>)}</tbody>
        </table></div> : <p className="muted">No payouts are recorded.</p>}
        {cyclesData.payouts_pagination && <div className="pagination-controls" aria-label="Paluwagan payout pages">
          <button className="button button-outline" type="button" disabled={payoutPage <= 1 || loading} onClick={() => setPayoutPage((page) => page - 1)}>Previous</button>
          <span>Page {payoutPage}</span>
          <button className="button button-outline" type="button" disabled={!cyclesData.payouts_pagination.has_more || loading} onClick={() => setPayoutPage((page) => page + 1)}>Next</button>
        </div>}
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

function SavingsPortal({ token, user, refreshKey, standalone = false, onDeposit }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [transactionPage, setTransactionPage] = useState(1)
  const [appliedTransactionFilters, setAppliedTransactionFilters] = useState({ q: '', type: 'all', from: '', to: '' })
  const endpoints = useMemo(() => {
    const params = new URLSearchParams({ page: String(transactionPage), per_page: '50' })
    if (staff && appliedTransactionFilters.q.trim()) params.set('q', appliedTransactionFilters.q.trim())
    if (staff && appliedTransactionFilters.type !== 'all') params.set('type', appliedTransactionFilters.type)
    if (staff && appliedTransactionFilters.from) params.set('from', appliedTransactionFilters.from)
    if (staff && appliedTransactionFilters.to) params.set('to', appliedTransactionFilters.to)
    return [`/savings?${params}`]
  }, [staff, transactionPage, appliedTransactionFilters])
  const { data, error, loading } = usePortalData(token, refreshKey, endpoints)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [selectedSavingsMember, setSelectedSavingsMember] = useState(null)
  const [withdrawalSubmitting, setWithdrawalSubmitting] = useState(false)
  const [withdrawalRequestKey, setWithdrawalRequestKey] = useState(null)
  const [withdrawalMode, setWithdrawalMode] = useState(false)
  const [withdrawalStep, setWithdrawalStep] = useState(1)
  const [withdrawalAmount, setWithdrawalAmount] = useState('')
  const [withdrawalChannel, setWithdrawalChannel] = useState('')
  const [autoPayDraft, setAutoPayDraft] = useState(null)
  const [autoPaySaving, setAutoPaySaving] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')
  const [transactionFilters, setTransactionFilters] = useState({ q: '', type: 'all', from: '', to: '' })
  const [exportingTransactions, setExportingTransactions] = useState(false)
  const transactions = data?.[0]?.transactions || []
  const balance = data?.[0]?.balance
  const memberBalances = data?.[0]?.member_balances || []
  const savingsSummary = data?.[0]?.summary
  const autoPaySettings = autoPayDraft || data?.[0]?.auto_pay_preferences || { loan: false, paluwagan: false }
  const filteredMembers = memberBalances.filter((member) =>
    `${member.member_number} ${member.first_name} ${member.last_name}`.toLowerCase().includes(memberSearch.trim().toLowerCase())
  )
  const filteredTransactions = transactions.filter((entry) => {
    const matchesText = `${entry.member_number || ''} ${entry.first_name || ''} ${entry.last_name || ''} ${entry.reference_no} ${entry.description || ''}`.toLowerCase()
      .includes(transactionFilters.q.trim().toLowerCase())
    const date = String(entry.created_at || '').slice(0, 10)
    return matchesText
      && (transactionFilters.type === 'all' || entry.type === transactionFilters.type)
      && (!transactionFilters.from || date >= transactionFilters.from)
      && (!transactionFilters.to || date <= transactionFilters.to)
  })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTransactionPage(1)
      setAppliedTransactionFilters(transactionFilters)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [transactionFilters])

  async function exportSavingsTransactions() {
    setExportingTransactions(true)
    setActionError('')
    try {
      const params = new URLSearchParams({ per_page: '100' })
      if (appliedTransactionFilters.q.trim()) params.set('q', appliedTransactionFilters.q.trim())
      if (appliedTransactionFilters.type !== 'all') params.set('type', appliedTransactionFilters.type)
      if (appliedTransactionFilters.from) params.set('from', appliedTransactionFilters.from)
      if (appliedTransactionFilters.to) params.set('to', appliedTransactionFilters.to)
      const allTransactions = []
      let page = 1
      let hasMore = true
      while (hasMore && page <= 10000) {
        params.set('page', String(page))
        const result = await apiRequest(`/savings?${params}`, { token })
        allTransactions.push(...(result.transactions || []))
        hasMore = Boolean(result.pagination?.has_more)
        page++
      }
      if (hasMore) throw new Error('The filtered export is too large to complete safely. Narrow the date range and try again.')
    const escapeCsv = (value) => {
      let text = String(value ?? '')
      if (/^\s*[=+\-@]/.test(text)) text = `'${text}`
      return `"${text.replace(/"/g, '""')}"`
    }
    const rows = [
      ['Date', 'Member number', 'Member', 'Type', 'Amount PHP', 'Balance after PHP', 'Reference', 'Description'],
      ...allTransactions.map((entry) => [
        entry.created_at,
        entry.member_number || '',
        `${entry.first_name || ''} ${entry.last_name || ''}`.trim(),
        entry.type,
        entry.amount,
        entry.balance_after,
        entry.reference_no,
        entry.description || '',
      ]),
    ]
    const content = rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'coopwise-savings-transactions.csv'
    anchor.click()
    URL.revokeObjectURL(url)
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setExportingTransactions(false)
    }
  }

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

  async function submitWithdrawal() {
    setActionError('')
    setNotice('')
    setWithdrawalSubmitting(true)
    const requestId = withdrawalRequestKey || crypto.randomUUID()
    setWithdrawalRequestKey(requestId)
    try {
      const result = await apiRequest('/savings/withdraw', {
        token, method: 'POST', body: JSON.stringify({
          amount: withdrawalAmount,
          channel: withdrawalChannel,
          request_id: requestId,
        }),
      })
      setNotice(result.message)
      setWithdrawalRequestKey(null)
      setWithdrawalMode(false)
      setWithdrawalStep(1)
      setWithdrawalAmount('')
      setWithdrawalChannel('')
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setWithdrawalSubmitting(false)
    }
  }

  if (!staff && withdrawalMode) {
    const destinations = [
      { id: 'gcash', name: 'GCash', type: 'E-wallet', icon: 'G' },
      { id: 'maya', name: 'Maya', type: 'E-wallet', icon: 'M' },
      { id: 'bank_bdo', name: 'BDO Bank', type: 'Bank transfer', icon: 'B' },
      { id: 'bank_bpi', name: 'BPI', type: 'Bank transfer', icon: 'B' },
      { id: 'bank_unionbank', name: 'UnionBank', type: 'Bank transfer', icon: 'U' },
    ]
    const selectedDestination = destinations.find((destination) => destination.id === withdrawalChannel)
    return <section className="portal-section withdrawal-page">
      <button className="text-button withdrawal-back-link" type="button" onClick={() => { setWithdrawalMode(false); setActionError('') }}>← Back to Savings</button>
      <div className="withdrawal-page-heading">
        <span className="withdrawal-page-icon"><StaffIcon name="savings" /></span>
        <div><span className="eyebrow">Demo transfer</span><h2>Withdraw</h2><p>Choose an amount and demo destination. No real money is sent.</p></div>
      </div>
      <ol className="withdrawal-stepper" aria-label="Withdrawal steps">
        {['Amount', 'Destination', 'Confirm'].map((step, index) => <li className={withdrawalStep === index + 1 ? 'active' : withdrawalStep > index + 1 ? 'complete' : ''} key={step}><span>{index + 1}</span>{step}</li>)}
      </ol>
      <PortalMessage error>{actionError}</PortalMessage>
      <div className="portal-card withdrawal-step-card">
        {withdrawalStep === 1 && <>
          <div className="item-heading"><div><span className="eyebrow">Step 1 of 3</span><h3>How much would you like to withdraw?</h3></div><span className="withdrawal-available">Available {formatPesos((balance || 0) / 100)}</span></div>
          <label className="withdrawal-amount-field">Withdrawal amount (PHP)
            <div className="withdrawal-currency-input"><span>PHP</span><input autoFocus type="number" min="0.01" max={((balance || 0) / 100).toFixed(2)} step="0.01" value={withdrawalAmount} onChange={(event) => { setWithdrawalAmount(event.target.value); setWithdrawalRequestKey(null) }} placeholder="0.00" /></div>
          </label>
          <div className="withdrawal-quick-amounts">{[100, 500, 1000].filter((amount) => amount <= (balance || 0) / 100).map((amount) => <button type="button" className="button button-outline" key={amount} onClick={() => { setWithdrawalAmount(String(amount)); setWithdrawalRequestKey(null) }}>PHP {amount}</button>)}</div>
          <button className="button button-primary withdrawal-next" type="button" disabled={!Number(withdrawalAmount) || Number(withdrawalAmount) <= 0 || Math.round(Number(withdrawalAmount) * 100) > (balance || 0)} onClick={() => { setActionError(''); setWithdrawalStep(2) }}>Choose destination</button>
        </>}
        {withdrawalStep === 2 && <>
          <span className="eyebrow">Step 2 of 3</span><h3>Where should this simulated withdrawal go?</h3>
          <p className="muted">Pick a destination type for the demo receipt. Do not enter real account numbers or credentials.</p>
          <div className="withdrawal-destination-grid">{destinations.map((destination) => <button type="button" className={`withdrawal-destination${withdrawalChannel === destination.id ? ' selected' : ''}`} key={destination.id} onClick={() => { setWithdrawalChannel(destination.id); setWithdrawalRequestKey(null) }} aria-pressed={withdrawalChannel === destination.id}>
            <span className="withdrawal-destination-icon">{destination.icon}</span><strong>{destination.name}</strong><small>{destination.type}</small>
          </button>)}</div>
          <p className="withdrawal-demo-note">QR Ph is for receiving payments; this withdrawal demo uses bank and e-wallet destinations only.</p>
          <div className="button-row"><button className="button button-outline" type="button" onClick={() => setWithdrawalStep(1)}>Back</button><button className="button button-primary" type="button" disabled={!withdrawalChannel} onClick={() => setWithdrawalStep(3)}>Review withdrawal</button></div>
        </>}
        {withdrawalStep === 3 && <>
          <span className="eyebrow">Step 3 of 3</span><h3>Review your withdrawal</h3>
          <dl className="withdrawal-review">
            <div><dt>Amount</dt><dd>{formatPesos(withdrawalAmount)}</dd></div>
            <div><dt>Destination</dt><dd>{selectedDestination?.name} · {selectedDestination?.type}</dd></div>
            <div><dt>Balance after simulation</dt><dd>{formatPesos(Math.max(0, ((balance || 0) - Math.round(Number(withdrawalAmount) * 100)) / 100))}</dd></div>
          </dl>
          <p className="withdrawal-demo-note">This only records a simulated withdrawal in CoopWise. No Xendit payout or actual bank/e-wallet transfer is made.</p>
          <div className="button-row"><button className="button button-outline" type="button" disabled={withdrawalSubmitting} onClick={() => { setWithdrawalStep(2); setWithdrawalRequestKey(null) }}>Change destination</button><button className="button button-primary" type="button" disabled={withdrawalSubmitting} onClick={submitWithdrawal}>{withdrawalSubmitting ? 'Processing simulation…' : `Confirm withdraw to ${selectedDestination?.name}`}</button></div>
        </>}
      </div>
    </section>
  }

  return (
    <section className="portal-section">
      {!standalone && <h2>Savings</h2>}
      {!staff && <div className="savings-member-overview">
        <div className="portal-card savings-balance"><span>Your available member balance</span><strong>{loading && !data ? 'Loading…' : formatPesos((balance || 0) / 100)}</strong></div>
        <button className="button button-primary" type="button" onClick={onDeposit}>Deposit to savings</button>
        <button className="button button-primary" type="button" onClick={() => { setSelectedSavingsMember(null); setLedgerOpen(true) }}>View / print my savings ledger</button>
      </div>}
      {!staff && <p className="muted">Add funds through Xendit Test Mode, or view other credits from approved loans and Paluwagan payouts. Test Mode deposits do not transfer real money.</p>}
      {!staff && data?.[0]?.balance_breakdown && <div className="report-grid savings-balance-breakdown">
        <article className="portal-card"><span>Loan proceeds credited</span><strong>{formatPesos(data[0].balance_breakdown.loan_credits)}</strong></article>
        <article className="portal-card"><span>Paluwagan payouts credited</span><strong>{formatPesos(data[0].balance_breakdown.paluwagan_credits)}</strong></article>
        <article className="portal-card"><span>Other historical credits</span><strong>{formatPesos(data[0].balance_breakdown.other_credits)}</strong></article>
        <article className="portal-card"><span>Total withdrawals recorded</span><strong>{formatPesos(data[0].balance_breakdown.withdrawals)}</strong></article>
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
      {staff && savingsSummary && <section className="savings-admin-overview">
        <h3>Member balance overview</h3>
        <div className="report-grid">
          <article className="portal-card"><span>Members with ledger</span><strong>{savingsSummary.member_count}</strong></article>
          <article className="portal-card"><span>Total available demo balance</span><strong>{formatPesos(savingsSummary.balance)}</strong></article>
          <article className="portal-card"><span>Recorded credits</span><strong>{formatPesos(savingsSummary.credits)}</strong></article>
          <article className="portal-card"><span>Recorded withdrawals</span><strong>{formatPesos(savingsSummary.debits)}</strong></article>
        </div>
        <label className="savings-search">Find a member<input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Member number or name" /></label>
        <div className="table-wrap"><table><thead><tr><th>Member</th><th>Status</th><th>Credits</th><th>Withdrawals</th><th>Available balance</th><th>Ledger</th></tr></thead>
          <tbody>{filteredMembers.map((member) => <tr key={member.id}>
            <td>{member.member_number} · {member.first_name} {member.last_name}</td>
            <td><span className={`status status-${member.status}`}>{member.status}</span></td>
            <td>{formatPesos(member.credits)}</td><td>{formatPesos(member.debits)}</td><td>{formatPesos(member.balance)}</td>
            <td><button className="text-button" type="button" onClick={() => { setSelectedSavingsMember(member); setLedgerOpen(true) }}>Open ledger</button></td>
          </tr>)}</tbody>
        </table></div>
        {!filteredMembers.length && <p className="muted">No members match that search.</p>}
      </section>}
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
      {!staff && (
        <section className="withdrawal-section">
          <div className="portal-card withdrawal-launch-card"><div><span className="eyebrow">Member balance</span><h3>Withdraw to a bank or e-wallet</h3><p className="muted">Choose a demo destination, review the amount, and confirm. The ledger updates instantly; no real transfer is made.</p></div>
            <button className="button button-primary" type="button" disabled={loading || !(balance > 0)} onClick={() => { setWithdrawalMode(true); setWithdrawalStep(1); setActionError('') }}>Withdraw</button>
          </div>
        </section>
      )}
      {staff && <div className="savings-transaction-tools">
        <h3>Transaction review</h3>
        <div className="savings-filter-row">
          <label>Search<input value={transactionFilters.q} onChange={(event) => setTransactionFilters({ ...transactionFilters, q: event.target.value })} placeholder="Member, reference, description" /></label>
          <label>Type<select value={transactionFilters.type} onChange={(event) => setTransactionFilters({ ...transactionFilters, type: event.target.value })}><option value="all">All activity</option><option value="deposit">Credits</option><option value="withdrawal">Withdrawals</option></select></label>
          <label>From<input type="date" value={transactionFilters.from} onChange={(event) => setTransactionFilters({ ...transactionFilters, from: event.target.value })} /></label>
          <label>To<input type="date" value={transactionFilters.to} onChange={(event) => setTransactionFilters({ ...transactionFilters, to: event.target.value })} /></label>
          <button className="button button-outline" type="button" onClick={exportSavingsTransactions} disabled={!filteredTransactions.length || exportingTransactions}>{exportingTransactions ? 'Preparing export…' : 'Export filtered CSV'}</button>
        </div>
      </div>}
      <div className="staff-subsection-title"><StaffIcon name="savings" /><h3>Transaction history</h3></div>
      {loading && !data && <StaffEmptyState type="savings" title="Loading savings history…" description="Please wait while we fetch the latest transactions." loading />}
      {data && transactions.length === 0 && <p className="muted">No savings transactions recorded.</p>}
      {staff && transactions.length > 0 && filteredTransactions.length === 0 && <p className="muted">No transactions match these filters.</p>}
      {!!filteredTransactions.length && <div className="table-wrap"><table><thead><tr>
        <th>Date</th>{staff && <th>Member</th>}<th>Type</th><th>Amount</th><th>Balance after</th><th>Reference</th><th>Description</th>
      </tr></thead><tbody>{filteredTransactions.map((entry) => <tr key={entry.id}>
        <td>{entry.created_at}</td>{staff && <td>{entry.member_number} · {entry.first_name} {entry.last_name}</td>}
        <td>{entry.type}</td><td>PHP {entry.amount}</td><td>PHP {entry.balance_after}</td><td>{entry.reference_no}</td><td>{entry.description || '—'}</td>
      </tr>)}</tbody></table></div>}
      {data?.[0]?.pagination && <div className="pagination-controls" aria-label="Savings history pages">
        <button className="button button-outline" type="button" disabled={transactionPage <= 1 || loading} onClick={() => setTransactionPage((page) => page - 1)}>Previous</button>
        <span>Page {transactionPage}</span>
        <button className="button button-outline" type="button" disabled={!data[0].pagination.has_more || loading} onClick={() => setTransactionPage((page) => page + 1)}>Next</button>
      </div>}
      {ledgerOpen && <SavingsLedgerDialog token={token} member={selectedSavingsMember} onClose={() => { setLedgerOpen(false); setSelectedSavingsMember(null) }} />}
    </section>
  )
}

function ShareCapitalPortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [transactionsPage, setTransactionsPage] = useState(1)
  const endpoints = useMemo(() => [
    `${SHARE_CAPITAL_ENDPOINTS[0]}?page=${transactionsPage}&per_page=50`,
    SHARE_CAPITAL_ENDPOINTS[1],
  ], [transactionsPage])
  const { data, error, loading } = usePortalData(token, refreshKey, endpoints)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const capital = data?.[0]
  const subscriptions = capital?.subscriptions || []
  const transactions = capital?.transactions || []
  const members = capital?.members || []
  const memberReturns = data?.[1]?.member_returns || []
  const reversedPaymentIds = new Set(transactions
    .filter((transaction) => transaction.transaction_type === 'reversal')
    .map((transaction) => Number(transaction.reverses_transaction_id)))
  const summary = capital?.summary || { subscribed_amount: 0, paid_up_amount: 0, unpaid_amount: 0 }

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

  async function reversePayment(transaction) {
    const reason = window.prompt('Enter the reason for reversing this payment. The original record will be kept.')
    if (reason === null) return
    if (!reason.trim()) {
      setActionError('Enter a reason before reversing a payment.')
      return
    }
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest(`/share-capital/payments/${transaction.id}/reverse`, {
        token, method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return (
    <section className="portal-section">
      {!standalone && <h2>Share capital</h2>}
      <p className="muted">Share capital represents member ownership in the cooperative. It is separate from savings and is not an ordinary savings withdrawal.</p>
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
      {capital && <div className="report-grid">
        <article className="portal-card"><span>Subscribed share capital</span><strong>{formatPesos(summary.subscribed_amount)}</strong></article>
        <article className="portal-card"><span>Paid-up share capital</span><strong>{formatPesos(summary.paid_up_amount)}</strong></article>
        <article className="portal-card"><span>Unpaid subscriptions</span><strong>{formatPesos(summary.unpaid_amount)}</strong></article>
      </div>}
      {!staff && <section>
        <h3>Approved member returns</h3>
        <p className="muted">These are approved interest-on-share-capital and patronage-refund allocations. They are separate from your share-capital balance and savings balance.</p>
        {!loading && memberReturns.length === 0 && <p className="muted">No approved member returns have been recorded for your account.</p>}
        {memberReturns.length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Fiscal year</th><th>Share capital basis</th><th>Interest on share capital</th><th>Patronage basis</th><th>Patronage refund</th><th>Total return</th></tr></thead>
          <tbody>{memberReturns.map((item) => <tr key={item.id}>
            <td>{item.fiscal_year}<small>Approved {item.approved_at}</small></td>
            <td>{formatPesos(item.paid_up_share_capital)}</td>
            <td>{formatPesos(item.interest_on_share_capital)}</td>
            <td>{formatPesos(item.patronage_basis)}</td>
            <td>{formatPesos(item.patronage_refund)}</td>
            <td>{formatPesos(item.total_return)}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>}
      {staff && capital && <>
        <details className="portal-card">
          <summary>Create share subscription</summary>
          <p className="muted">Use only the share count and par value approved by the cooperative. Creating a subscription records an amount owed; it does not record money received.</p>
          <form className="form-grid" onSubmit={(event) => submit(event, '/share-capital/subscriptions', 'Subscription created.')}>
            <label>Member<select name="member_id" required defaultValue="">
              <option value="" disabled>Select a member</option>
              {members.map((member) => <option key={member.id} value={member.id}>{member.member_number} · {member.first_name} {member.last_name}</option>)}
            </select></label>
            <label>Shares subscribed<input name="subscribed_shares" type="number" min="1" step="1" required /></label>
            <label>Par value per share (PHP)<input name="par_value" type="number" min="0.01" step="0.01" required /></label>
            <label>Subscription date<input name="subscription_date" type="date" max={TODAY} defaultValue={TODAY} required /></label>
            <button className="button button-primary" type="submit">Create subscription</button>
          </form>
        </details>
      </>}
      <h3>Share subscriptions</h3>
      {loading && <StaffEmptyState type="members" title="Loading share capital…" description="Please wait while share subscriptions are retrieved." loading />}
      {!loading && capital && !subscriptions.length && <StaffEmptyState type="members" title="No subscriptions recorded" description={staff ? 'Create a subscription using the cooperative-approved share terms.' : 'Your share subscriptions will appear here after cooperative staff records them.'} />}
      {subscriptions.length > 0 && <div className="table-wrap"><table>
        <thead><tr>{staff && <th>Member</th>}<th>Subscription</th><th>Shares × par value</th><th>Subscribed</th><th>Paid up</th><th>Unpaid</th><th>Status</th></tr></thead>
        <tbody>{subscriptions.map((item) => <tr key={item.id}>
          {staff && <td>{item.member_number} · {item.first_name} {item.last_name}</td>}
          <td>{item.subscription_number}<small>{item.subscription_date}</small></td>
          <td>{item.subscribed_shares} × {formatPesos(item.par_value)}</td>
          <td>{formatPesos(item.subscribed_amount)}</td>
          <td>{formatPesos(item.paid_up_amount)}</td>
          <td>{formatPesos(item.unpaid_amount)}</td>
          <td><span className={`status status-${item.status}`}>{item.status}</span></td>
        </tr>)}</tbody>
      </table></div>}
      <h3>Contribution history</h3>
      {!loading && capital && !transactions.length && <p className="muted">No share capital contributions or corrections have been recorded.</p>}
      {transactions.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>Date / reference</th>{staff && <th>Member</th>}<th>Subscription</th><th>Activity</th><th>Amount</th><th>Paid-up balance</th><th>Method / reason</th>{staff && <th>Correction</th>}</tr></thead>
        <tbody>{transactions.map((transaction) => <tr key={transaction.id}>
          <td>{transaction.created_at}<small>{transaction.transaction_reference}</small></td>
          {staff && <td>{transaction.member_number} · {transaction.first_name} {transaction.last_name}</td>}
          <td>{transaction.subscription_number}</td>
          <td>{transaction.transaction_type === 'reversal' ? `Reversal of #${transaction.reverses_transaction_id}` : 'Contribution'}</td>
          <td>{transaction.transaction_type === 'reversal' ? '−' : ''}{formatPesos(transaction.amount)}</td>
          <td>{formatPesos(transaction.balance_after)}</td>
          <td>{transaction.payment_method || transaction.description || '—'}</td>
          {staff && <td>{transaction.transaction_type === 'payment' && !Number(transaction.is_reversed) && !reversedPaymentIds.has(Number(transaction.id)) && <button className="text-button" type="button" onClick={() => reversePayment(transaction)}>Reverse</button>}</td>}
        </tr>)}</tbody>
      </table></div>}
      {capital?.pagination && <div className="pagination-controls" aria-label="Share capital history pages">
        <button className="button button-outline" type="button" disabled={transactionsPage <= 1 || loading} onClick={() => setTransactionsPage((page) => page - 1)}>Previous</button>
        <span>Page {transactionsPage}</span>
        <button className="button button-outline" type="button" disabled={!capital.pagination.has_more || loading} onClick={() => setTransactionsPage((page) => page + 1)}>Next</button>
      </div>}
    </section>
  )
}

function LearningCenter({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error, loading } = usePortalData(token, refreshKey, POLICY_ENDPOINTS)
  const [policyDraft, setPolicyDraft] = useState(null)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const policies = policyDraft || data?.[0]?.policies
  const policyFields = [
    ['membership_policy', 'Membership'],
    ['share_capital_policy', 'Share capital'],
    ['loan_policy', 'Loans'],
    ['paluwagan_policy', 'Paluwagan'],
    ['demo_balance_policy', 'Demo balance and withdrawals'],
  ]

  async function savePolicies(event) {
    event.preventDefault()
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/cooperative/policies', {
        token, method: 'POST', body: JSON.stringify(policyDraft),
      })
      setNotice(result.message)
      setPolicyDraft(null)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return <section className="portal-section learning-center">
    {!standalone && <h2>Cooperative Learning Center</h2>}
    <p className="muted">A cooperative is owned and used by its members. Members participate in services and help shape the cooperative according to its bylaws and policies. This site is a classroom simulation—not a bank or a substitute for your cooperative’s official rules.</p>
    <div className="learning-grid">
      <article className="portal-card"><span className="eyebrow">01 · Membership</span><h3>Members are owners</h3><p>Members join under the cooperative’s membership rules, use services, and share responsibility for the organization. Membership is more than having a login.</p></article>
      <article className="portal-card"><span className="eyebrow">02 · Share capital</span><h3>Ownership, not wallet money</h3><p>Share capital represents a member’s ownership contribution. CoopWise tracks subscriptions and paid-up amounts separately from the available demo balance.</p></article>
      <article className="portal-card"><span className="eyebrow">03 · Loans</span><h3>Borrow from a pooled fund</h3><p>Approved loans draw from a separately tracked simulated lending pool, not by reducing a member’s share capital. Members repay principal and interest under a reviewed schedule.</p></article>
      <article className="portal-card"><span className="eyebrow">04 · Paluwagan</span><h3>Contribute to a rotating pool</h3><p>Enrolled members contribute to a scheduled cycle. The system tracks the order and contributions; staff confirm the simulated payout to the next recipient.</p></article>
      <article className="portal-card"><span className="eyebrow">05 · Payments</span><h3>Know what is real</h3><p>Where enabled, Xendit Test Mode checks an incoming checkout simulation. Never enter real payment details for a class demo. CoopWise simulated withdrawals do not send money.</p></article>
      <article className="portal-card"><span className="eyebrow">06 · Records</span><h3>Keep the history clear</h3><p>Each balance credit or debit should have a source and reference. Share capital stays separate, and corrections should be recorded with a reason rather than deleting history.</p></article>
      <article className="portal-card"><span className="eyebrow">07 · Member returns</span><h3>Surplus is not guaranteed</h3><p>After the cooperative determines and allocates its net surplus under its rules, an approved distribution may include interest on share capital and patronage refunds. Loan interest is charged to borrowers; it is not itself a dividend.</p></article>
    </div>
    <section className="policy-section">
      <div className="section-heading"><div><h3>Cooperative policies for this demo</h3><p className="muted">These are this project’s sample rules, not universal cooperative rules or legal advice.</p></div></div>
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
      {loading && !policies && <p className="muted">Loading current demo policies…</p>}
      {!loading && !policies && !error && <p className="muted">No demo policies have been published.</p>}
      {policies && staff && <form className="portal-card form-grid policy-form" onSubmit={savePolicies}>
        {policyFields.map(([key, label]) => <label className="full" key={key}>{label} policy
          <textarea rows="4" maxLength="5000" required value={policies[key] || ''} onChange={(event) => setPolicyDraft({ ...policies, [key]: event.target.value })} />
        </label>)}
        <div className="full">
          <h4>Configurable sample loan eligibility</h4>
          <p className="muted">These are this demonstration cooperative’s rules, not universal legal requirements. Share capital remains ownership and is not spent when a member borrows.</p>
        </div>
        <label>Minimum membership period (days)<input type="number" min="0" max="3650" step="1" required value={policies.minimum_membership_days ?? 30} onChange={(event) => setPolicyDraft({ ...policies, minimum_membership_days: event.target.value })} /></label>
        <label>Minimum paid-up share capital (PHP)<input type="number" min="0" step="0.01" required value={policies.minimum_paid_up_share_capital ?? '5000.00'} onChange={(event) => setPolicyDraft({ ...policies, minimum_paid_up_share_capital: event.target.value })} /></label>
        <label>Minimum savings balance (PHP)<input type="number" min="0" step="0.01" required value={policies.minimum_savings_balance ?? '0.00'} onChange={(event) => setPolicyDraft({ ...policies, minimum_savings_balance: event.target.value })} /></label>
        <label>Maximum loan ÷ paid-up share capital<input type="number" min="0" max="100" step="0.01" required value={policies.loan_to_paid_up_share_capital_multiplier ?? '1.00'} onChange={(event) => setPolicyDraft({ ...policies, loan_to_paid_up_share_capital_multiplier: event.target.value })} /></label>
        <label className="full">Cooperative registration date (required for surplus distribution)<input type="date" max={TODAY} value={policies.cooperative_registration_date || ''} onChange={(event) => setPolicyDraft({ ...policies, cooperative_registration_date: event.target.value })} /><small>Used to apply the first-five-years reserve rule when staff prepare an annual surplus distribution.</small></label>
        <button className="button button-primary" type="submit" disabled={!policyDraft}>Save demo policies</button>
        {policies.updated_at && <small className="full">Last updated: {policies.updated_at}</small>}
      </form>}
      {policies && !staff && <div className="policy-grid">
        {policyFields.map(([key, label]) => <article className="portal-card" key={key}><h4>{label}</h4><p>{policies[key]}</p></article>)}
        <article className="portal-card"><h4>Loan eligibility sample rules</h4>
          <p>Minimum membership: {policies.minimum_membership_days} days. Minimum paid-up share capital: {formatPesos(policies.minimum_paid_up_share_capital)}. Minimum savings: {formatPesos(policies.minimum_savings_balance)}. Maximum loan limit: {policies.loan_to_paid_up_share_capital_multiplier} × paid-up share capital, less any current loan balance.</p>
          <p>These are the current configured sample rules. Eligibility allows you to apply; staff review and available cooperative funds still determine whether a loan is approved.</p>
        </article>
        {policies.updated_at && <small>Last updated: {policies.updated_at}</small>}
      </div>}
    </section>
  </section>
}

function DemoGuide({ setSection, standalone = false }) {
  const steps = [
    { title: 'Understand the cooperative', section: 'learning', description: 'Learn what membership, share capital, loans, and Paluwagan mean in this classroom demo.' },
    { title: 'Compare sample loan offers', section: 'loans', description: 'Review the example interest rate and repayment schedule before applying. Staff review the application.' },
    { title: 'Explore a Paluwagan cycle', section: 'cooperative', description: 'See the contribution amount, randomized order, daily records, and payout status.' },
    { title: 'Review your balance sources', section: 'savings', description: 'An approved loan draws from the simulated cooperative lending pool and credits your demo savings; it never reduces your share capital.' },
    { title: 'Try a simulated withdrawal', section: 'savings', description: 'Choose a demo e-wallet or bank destination. The ledger updates, but no real money is transferred.' },
  ]
  return <section className="portal-section demo-guide">
    {!standalone && <h2>Guided demo walkthrough</h2>}
    <p className="muted">Follow this non-destructive tour to explain the main cooperative flow. It does not create, change, or reset account records.</p>
    <div className="demo-scenario portal-card">
      <span className="eyebrow">Illustrative sample only · Not a real member record</span>
      <h3>Example balance story</h3>
      <div className="demo-scenario-flow">
        <span>Approved loan credit <strong>+ PHP 8,000</strong></span><b>→</b>
        <span>Paluwagan payout <strong>+ PHP 2,000</strong></span><b>→</b>
        <span>Simulated withdrawal to GCash <strong>− PHP 500</strong></span><b>→</b>
        <span>Example available balance <strong>PHP 9,500</strong></span>
      </div>
      <p className="muted">Amounts are fictional examples displayed for explanation only; they are not added to your database.</p>
    </div>
    <ol className="demo-step-list">{steps.map((step, index) => <li className="portal-card demo-step" key={step.title}>
      <span className="demo-step-number">{index + 1}</span>
      <div><h3>{step.title}</h3><p>{step.description}</p></div>
      <button className="button button-outline" type="button" onClick={() => setSection(step.section)}>Open section</button>
    </li>)}</ol>
  </section>
}

function GoogleReportChart({ title, rows, type = 'column' }) {
  const containerRef = useRef(null)
  const [chartError, setChartError] = useState('')
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light')
  const hasValues = rows.length > 1 && rows.slice(1).some((row) => Number(row[1]) > 0)

  useEffect(() => {
    const updateTheme = () => setTheme(document.documentElement.dataset.theme || 'light')
    window.addEventListener('coopwise:theme-change', updateTheme)
    return () => window.removeEventListener('coopwise:theme-change', updateTheme)
  }, [])

  useEffect(() => {
    let active = true
    let chart = null
    let resizeObserver = null
    let resizeListener = null

    if (!hasValues) return undefined

    loadGoogleCharts()
      .then(() => {
        if (!active || !containerRef.current) return
        const chartTextColor = theme === 'dark' ? '#c2d5cb' : '#52665c'
        const chartGridColor = theme === 'dark' ? '#344a40' : '#d9e2dd'
        const chartData = window.google.visualization.arrayToDataTable(rows)
        const options = {
          backgroundColor: 'transparent',
          chartArea: { left: 58, top: 20, width: '82%', height: '72%' },
          colors: theme === 'dark'
            ? ['#5b9c84', '#7e9fb3', '#b49a67', '#8695b3', '#ae8197', '#6f9fa6']
            : ['#17815b', '#68b997', '#e3a343', '#6b85c2', '#b56c8d', '#69aab7'],
          fontName: 'Arial',
          height: 300,
          legend: type === 'pie' ? { position: 'bottom', textStyle: { color: chartTextColor } } : { position: 'none' },
          pieHole: type === 'pie' ? 0.48 : undefined,
          vAxis: type === 'column' ? { minValue: 0, textStyle: { color: chartTextColor }, gridlines: { color: chartGridColor } } : undefined,
          hAxis: type === 'column' ? { textStyle: { color: chartTextColor }, gridlines: { color: 'transparent' } } : undefined,
        }
        chart = type === 'pie'
          ? new window.google.visualization.PieChart(containerRef.current)
          : new window.google.visualization.ColumnChart(containerRef.current)
        const draw = () => {
          if (active && containerRef.current) {
            options.width = Math.max(280, containerRef.current.clientWidth)
            chart.draw(chartData, options)
          }
        }
        draw()
        if (window.ResizeObserver) {
          resizeObserver = new window.ResizeObserver(draw)
          resizeObserver.observe(containerRef.current)
        } else {
          resizeListener = draw
          window.addEventListener('resize', resizeListener)
        }
      })
      .catch((error) => {
        if (active) setChartError(error.message)
      })

    return () => {
      active = false
      resizeObserver?.disconnect()
      if (resizeListener) window.removeEventListener('resize', resizeListener)
      chart?.clearChart()
    }
  }, [hasValues, rows, theme, type])

  return <article className="portal-card report-chart-card">
    <h4>{title}</h4>
    {!hasValues
      ? <p className="muted">No chart data is available for this period.</p>
      : chartError
        ? <p className="muted">Chart unavailable: {chartError}</p>
        : <div ref={containerRef} className="google-report-chart" role="img" aria-label={title} />}
  </article>
}

function ReportsPortal({ token, refreshKey, standalone = false }) {
  const { data, error, loading } = usePortalData(token, refreshKey, REPORT_ENDPOINTS)
  const report = data?.[0]
  const finance = data?.[1]
  const surplusDistributions = data?.[2]?.distributions || []
  const registrationYear = finance?.cooperative_registration_date
    ? Number(finance.cooperative_registration_date.slice(0, 4))
    : null
  const completedFiscalYear = CURRENT_YEAR - 1
  const hasCompletedFiscalYear = !registrationYear || registrationYear <= completedFiscalYear
  const minimumReservePercent = registrationYear && completedFiscalYear - registrationYear < 5 ? 50 : 10
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const financialChartRows = useMemo(() => report ? [
    ['Activity', 'PHP'],
    ['Savings deposits', Number(report.monthly.savings_deposits) || 0],
    ['Savings withdrawals', Number(report.monthly.savings_withdrawals) || 0],
    ['Share capital contributions', Number(report.monthly.share_capital_payments) || 0],
    ['Loan principal repaid', Number(report.monthly.loan_principal_received) || 0],
    ['Loan interest received', Number(report.monthly.loan_interest_received) || 0],
  ] : [], [report])
  const loanStatusChartRows = useMemo(() => report ? [
    ['Loan status', 'Applications'],
    ...(report.loan_statuses || []).map((entry) => [entry.status, Number(entry.total) || 0]),
  ] : [], [report])

  async function addLoanFund(event) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/cooperative/finance/fund', {
        token, method: 'POST', body: JSON.stringify(values),
      })
      setNotice(result.message)
      form.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function createSurplusDraft(event) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/cooperative/surplus', {
        token, method: 'POST', body: JSON.stringify(values),
      })
      setNotice(result.message)
      form.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function approveSurplus(distribution) {
    const amount = Number(distribution.share_capital_pool) + Number(distribution.patronage_pool)
    if (!window.confirm(`Publish the ${distribution.fiscal_year} member-return distribution totaling ${formatPesos(amount)} for ${distribution.member_count} members? Confirm the net surplus and required approvals before proceeding.`)) return
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest(`/cooperative/surplus/${distribution.id}/approve`, {
        token, method: 'POST', body: JSON.stringify({}),
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function cancelSurplus(distribution) {
    if (!window.confirm(`Cancel the unpublished ${distribution.fiscal_year} draft? Its calculated member rows will be removed, and staff can prepare a corrected draft.`)) return
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest(`/cooperative/surplus/${distribution.id}/cancel`, {
        token, method: 'POST', body: JSON.stringify({}),
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  return (
    <section className="portal-section">
      <PortalMessage error>{error}</PortalMessage>
      <PortalMessage error>{actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
      {!report && !error && <StaffEmptyState
        type="report"
        title={loading ? 'Loading current figures…' : 'No report figures yet.'}
        description={loading ? 'Please wait while we fetch the latest data.' : 'Recorded cooperative totals will appear here.'}
        loading={loading}
      />}
      {report && <>
        {!standalone && <h2>Reports</h2>}
        <p className="muted">Live totals from recorded CoopWise transactions. Monthly activity: {report.period}.</p>
        <div className="report-grid">
          <article className="portal-card"><span>Members</span><strong>{report.summary.members}</strong><small>{report.summary.active_members} active</small></article>
          <article className="portal-card"><span>Available member balance</span><strong>PHP {report.summary.savings_balance}</strong></article>
          <article className="portal-card"><span>Paid-up share capital</span><strong>PHP {report.summary.share_capital_paid_up || '0.00'}</strong><small>Subscribed: PHP {report.summary.share_capital_subscribed || '0.00'}</small></article>
          <article className="portal-card"><span>Loan portfolio</span><strong>PHP {report.summary.loan_balance}</strong></article>
          <article className="portal-card"><span>Outstanding loan principal</span><strong>{formatPesos(report.summary.loan_principal_receivable)}</strong></article>
          <article className="portal-card"><span>Simulated lending pool available</span><strong>{formatPesos(report.summary.loan_fund_available)}</strong></article>
          <article className="portal-card"><span>Loan payments received</span><strong>PHP {report.summary.loan_payments_received}</strong></article>
          <article className="portal-card"><span>Loan interest received</span><strong>{formatPesos(report.summary.loan_interest_received)}</strong></article>
          <article className="portal-card"><span>Approved member returns</span><strong>{formatPesos(report.summary.approved_member_returns)}</strong></article>
        </div>
        <p className="muted">The simulated lending pool is recorded separately from member savings and share capital. It must be funded by staff before loans can be approved; member share capital is not automatically deducted or treated as available cash.</p>
        <details className="portal-card">
          <summary>Record simulated lending-pool funding</summary>
          <form className="form-grid" onSubmit={addLoanFund}>
            <label>Amount (PHP)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
            <label>Description<input name="description" maxLength="255" placeholder="Example: initial classroom lending pool" /></label>
            <button className="button button-primary" type="submit">Add demo funding</button>
          </form>
          <small>This records a simulated funding source only. It does not collect or transfer real money.</small>
        </details>
        <h3>Operational overview</h3>
        <div className="report-grid">
          <article className="portal-card"><span>Loan applications awaiting review</span><strong>{report.operations?.loans_awaiting_review ?? '—'}</strong></article>
          <article className="portal-card"><span>Document sets awaiting review</span><strong>{report.operations?.documents_awaiting_review ?? '—'}</strong></article>
          <article className="portal-card"><span>Active Paluwagan cycles</span><strong>{report.operations?.active_paluwagan_cycles ?? '—'}</strong></article>
          <article className="portal-card"><span>Payouts awaiting confirmation</span><strong>{report.operations?.payouts_awaiting_confirmation ?? '—'}</strong></article>
          <article className="portal-card"><span>Overdue installments</span><strong>{report.operations?.overdue_installment_count ?? '—'}</strong><small>Outstanding: PHP {report.operations?.overdue_installment_balance ?? '—'}</small></article>
        </div>
        <h3>Visual summaries</h3>
        <p className="muted">Charts use cooperative-wide totals from recorded CoopWise activity. They do not display member names or account-level details.</p>
        <div className="report-chart-grid">
          <GoogleReportChart title={`Monthly financial activity · ${report.period}`} rows={financialChartRows} />
          <GoogleReportChart title="Loan applications by status · all time" rows={loanStatusChartRows} type="pie" />
        </div>
        <h3>Monthly activity</h3>
        <div className="table-wrap"><table><thead><tr><th>Activity</th><th>Value</th></tr></thead><tbody>
          <tr><td>New members</td><td>{report.monthly.new_members}</td></tr>
          <tr><td>Member balance credits</td><td>PHP {report.monthly.savings_deposits}</td></tr>
          <tr><td>Member balance withdrawals</td><td>PHP {report.monthly.savings_withdrawals}</td></tr>
          <tr><td>Share capital contributions</td><td>PHP {report.monthly.share_capital_payments || '0.00'}</td></tr>
          <tr><td>Loan principal repaid</td><td>{formatPesos(report.monthly.loan_principal_received)}</td></tr>
          <tr><td>Loan interest received</td><td>{formatPesos(report.monthly.loan_interest_received)}</td></tr>
        </tbody></table></div>
        <section className="surplus-management">
          <h3>Annual surplus and member returns</h3>
          <p className="muted">Create a draft from a reconciled, completed fiscal-year net surplus. CoopWise calculates member allocations from paid-up share capital at year end and interest actually paid on loans during that year (a classroom patronage proxy). Drafts do not publish returns. Approval publishes the return calculation only; this demo does not deposit or transfer money. Staff must verify the cooperative’s bylaws, applicable limits, accounts, and required approvals before publishing.</p>
          <details className="portal-card">
            <summary>Prepare annual distribution draft</summary>
            {!hasCompletedFiscalYear && <p className="muted">A completed fiscal year after the cooperative’s registration year is required before a distribution can be prepared.</p>}
            <form className="form-grid" onSubmit={createSurplusDraft}>
              <label>Completed fiscal year<input name="fiscal_year" type="number" min={registrationYear || 2000} max={completedFiscalYear} defaultValue={completedFiscalYear} step="1" required disabled={!hasCompletedFiscalYear} /></label>
              <label>Reconciled net surplus (PHP)<input name="net_surplus" type="number" min="0.01" step="0.01" required /></label>
              <label>Reserve fund (%)<input name="reserve_percent" type="number" min={minimumReservePercent} max="100" step="0.01" defaultValue="50" required /></label>
              <label>Education and training fund (%)<input name="education_percent" type="number" min="0" max="10" step="0.01" defaultValue="5" required /></label>
              <label>Community development fund (%)<input name="community_percent" type="number" min="3" max="100" step="0.01" defaultValue="3" required /></label>
              <label>Optional funds (%)<input name="optional_percent" type="number" min="0" max="7" step="0.01" defaultValue="0" required /></label>
              <label>Remaining member pool for interest on share capital (%)<input name="share_capital_pool_percent" type="number" min="0" max="100" step="0.01" defaultValue="50" required /></label>
              <button className="button button-primary" type="submit" disabled={!hasCompletedFiscalYear}>Calculate and save draft</button>
            </form>
            <small>The remaining member pool is split between interest on share capital and patronage refunds. Interest is not guaranteed; staff must verify the permitted return under the cooperative’s actual rules.</small>
          </details>
          {surplusDistributions.length > 0 && <div className="table-wrap"><table>
            <thead><tr><th>Year / status</th><th>Net surplus</th><th>Required fund allocations</th><th>Member-return pools</th><th>Members</th><th>Prepared / approved by</th><th>Action</th></tr></thead>
            <tbody>{surplusDistributions.map((distribution) => <tr key={distribution.id}>
              <td>{distribution.fiscal_year}<small>{distribution.status}</small></td>
              <td>{formatPesos(distribution.net_surplus)}</td>
              <td>Reserve {formatPesos(distribution.reserve_allocation)}<small>Education {formatPesos(distribution.education_allocation)} · Community {formatPesos(distribution.community_allocation)} · Optional {formatPesos(distribution.optional_allocation)}</small></td>
              <td>Share-capital interest {formatPesos(distribution.share_capital_pool)}<small>Patronage refunds {formatPesos(distribution.patronage_pool)} · Total {formatPesos(distribution.total_member_returns)}</small></td>
              <td>{distribution.member_count}</td>
              <td>{distribution.created_by_name || 'Staff'}<small>{distribution.approved_by_name ? `Approved by ${distribution.approved_by_name}` : 'Awaiting staff approval'}</small></td>
              <td>{distribution.status === 'draft' && <><button className="button button-primary" type="button" onClick={() => approveSurplus(distribution)}>Approve and publish</button> <button className="button" type="button" onClick={() => cancelSurplus(distribution)}>Cancel draft</button></>}</td>
            </tr>)}</tbody>
          </table></div>}
          {finance?.fund_transactions?.length > 0 && <details className="portal-card">
            <summary>Recent simulated lending-pool activity</summary>
            <div className="table-wrap"><table><thead><tr><th>Date / reference</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Loan</th><th>Staff</th></tr></thead>
              <tbody>{finance.fund_transactions.map((transaction) => <tr key={transaction.id}>
                <td>{transaction.created_at}<small>{transaction.reference_no}</small></td>
                <td>{transaction.transaction_type.replaceAll('_', ' ')}</td>
                <td>{formatPesos(transaction.amount)}</td>
                <td>{formatPesos(transaction.balance_after)}</td>
                <td>{transaction.loan_code || '—'}</td>
                <td>{transaction.actor_name || 'System'}</td>
              </tr>)}</tbody>
            </table></div>
          </details>}
        </section>
        <h3>Loan applications by status</h3>
        {Object.keys(report.monthly.loan_applications).length
          ? <ul className="member-order">{Object.entries(report.monthly.loan_applications).map(([status, count]) => <li key={status}>{status}: {count}</li>)}</ul>
          : <p className="muted">No loan applications this month.</p>}
        <h3>Recent activity</h3>
        {report.activity_logs?.length ? <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Actor</th><th>Area</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>{report.activity_logs.map((entry) => <tr key={entry.id}>
            <td>{entry.created_at}</td>
            <td>{entry.actor_name || 'System'}<small>{entry.actor_role || 'automated'}</small></td>
            <td>{entry.module}</td>
            <td>{entry.action}</td>
            <td>{entry.details || '—'}</td>
          </tr>)}</tbody>
        </table></div> : <p className="muted">No staff activity has been recorded.</p>}
      </>}
    </section>
  )
}

function PaymentPortal({ token, user, refreshKey, standalone = false, initialPurpose = 'loan' }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [transactionsPage, setTransactionsPage] = useState(1)
  const endpoints = useMemo(() => PAYMENT_ENDPOINTS.map((path) =>
    path === '/checkout-transactions' ? `${path}?page=${transactionsPage}&per_page=25` : path
  ), [transactionsPage])
  const { data, error, loading, refreshEndpoint } = usePortalData(token, refreshKey, endpoints)
  const [notice, setNotice] = useState(() => {
    const result = new URLSearchParams(window.location.search).get('payment')
    if (result === 'success') return 'Xendit returned you to CoopWise. We are checking the payment; your account changes after Xendit confirms it.'
    if (result === 'cancelled') return 'Checkout was cancelled. No payment has been added to your account.'
    return ''
  })
  const [actionError, setActionError] = useState('')
  const [purpose, setPurpose] = useState(initialPurpose)
  const [paymentMethod, setPaymentMethod] = useState('xendit')
  const savingsPaymentRequest = useRef(null)
  const [submitting, setSubmitting] = useState(false)
  const [slowCheckout, setSlowCheckout] = useState(false)
  const [checkingPayment, setCheckingPayment] = useState(null)
  const [cancellingPayment, setCancellingPayment] = useState(null)
  const [replacementPayment, setReplacementPayment] = useState(null)
  const loans = data?.[0]?.loans || []
  const cycles = data?.[1]?.cycles || []
  const subscriptions = data?.[2]?.subscriptions || []
  const transactions = data?.[3]?.transactions || []
  const transactionsPagination = data?.[3]?.pagination
  const savingsBalance = data?.[4]?.balance
  const effectivePaymentMethod = purpose === 'savings' ? 'xendit' : paymentMethod
  const hasUnsettledCheckout = transactions.some((transaction) =>
    transaction.status === 'pending' || (transaction.status === 'needs_review' && transaction.checkout_url)
  )

  useEffect(() => {
    let active = true
    const params = new URLSearchParams(window.location.search)
    const result = params.get('payment')
    const transactionId = params.get('transaction')
    if (result === 'success' || result === 'cancelled') {
      params.delete('payment')
      params.delete('transaction')
      const query = params.toString()
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
      )
    }
    if (result === 'success') {
      if (transactionId && /^\d+$/.test(transactionId)) {
        apiRequest(`/checkout-transactions/${transactionId}/sync`, { token, method: 'POST' })
          .then((response) => {
            if (active) {
              setNotice(response.status === 'paid'
                ? 'Payment confirmed. Your CoopWise account has been updated.'
                : 'Payment is still processing. CoopWise will update after Xendit confirms it.')
            }
          })
          .catch((requestError) => {
            if (active) setActionError(requestError.message)
          })
          .finally(() => {
            if (active) window.dispatchEvent(new Event('coopwise:refresh'))
          })
      } else {
        window.dispatchEvent(new Event('coopwise:refresh'))
      }
    }
    return () => { active = false }
  }, [token])

  useEffect(() => {
    if (staff || !hasUnsettledCheckout) return undefined

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshEndpoint(`/checkout-transactions?page=${transactionsPage}&per_page=25`).catch((requestError) => setActionError(requestError.message))
      }
    }, 10000)
    return () => window.clearInterval(interval)
  }, [refreshEndpoint, staff, hasUnsettledCheckout, transactionsPage])

  async function startCheckout(event) {
    event.preventDefault()
    setNotice('')
    setActionError('')
    setSubmitting(true)
    setSlowCheckout(false)
    const form = event.currentTarget
    const formData = new FormData(form)
    const selectedPaymentMethod = String(formData.get('payment_method') || 'xendit')
    const slowCheckoutTimer = selectedPaymentMethod === 'xendit'
      ? window.setTimeout(() => setSlowCheckout(true), 4000)
      : null
    const values = { purpose, payment_method: selectedPaymentMethod, amount: formData.get('amount') }
    if (purpose === 'loan') values.loan_id = formData.get('loan_id')
    if (purpose === 'paluwagan') values.cycle_id = formData.get('cycle_id')
    if (purpose === 'share_capital') values.subscription_id = formData.get('subscription_id')
    if (selectedPaymentMethod === 'savings') {
      const currentDate = new Date()
      const localDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`
      const signature = JSON.stringify({ ...values, business_date: purpose === 'paluwagan' ? localDate : null })
      if (!savingsPaymentRequest.current || savingsPaymentRequest.current.signature !== signature) {
        savingsPaymentRequest.current = { signature, requestId: crypto.randomUUID() }
      }
      values.request_id = savingsPaymentRequest.current.requestId
    }
    try {
      const result = await apiRequest('/checkout-transactions', {
        token, method: 'POST', body: JSON.stringify(values),
      })
      if (slowCheckoutTimer) window.clearTimeout(slowCheckoutTimer)
      if (result.payment_method === 'savings') {
        setNotice(result.message || 'Payment confirmed and deducted from your savings.')
        savingsPaymentRequest.current = null
        setReplacementPayment(null)
        setSubmitting(false)
        window.dispatchEvent(new Event('coopwise:refresh'))
        return
      }
      window.location.assign(result.checkout_url)
    } catch (requestError) {
      if (slowCheckoutTimer) window.clearTimeout(slowCheckoutTimer)
      setActionError(requestError.message)
      setSubmitting(false)
      setSlowCheckout(false)
    }
  }

  async function refreshPayment(transaction) {
    setNotice('')
    setActionError('')
    setCheckingPayment(transaction.id)
    try {
      const result = await apiRequest(`/checkout-transactions/${transaction.id}/sync`, { token, method: 'POST' })
      setNotice(result.status === 'paid'
        ? 'Payment confirmed. Your CoopWise account has been updated.'
        : result.status === 'needs_review'
          ? result.message
        : 'Payment is still processing. CoopWise will update after Xendit confirms it.')
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setCheckingPayment(null)
    }
  }

  async function cancelAndSwitchToSavings(transaction) {
    const confirmed = window.confirm(
      'Cancel this pending CoopWise payment and switch to savings? Close the old Xendit checkout without paying. If you already completed payment on Xendit, choose Check status instead.'
    )
    if (!confirmed) return
    setNotice('')
    setActionError('')
    setCancellingPayment(transaction.id)
    try {
      const result = await apiRequest(`/checkout-transactions/${transaction.id}/cancel`, {
        token, method: 'POST', body: JSON.stringify({}),
      })
      setPurpose(transaction.purpose)
      setPaymentMethod('savings')
      setReplacementPayment({
        transaction_id: transaction.id,
        loan_id: transaction.loan_id,
        cycle_id: transaction.cycle_id,
        subscription_id: transaction.subscription_id,
        amount: transaction.amount,
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setCancellingPayment(null)
    }
  }

  return (
    <section className="portal-section">
      <div className="section-heading">
        {!standalone && <div>
          <div className="eyebrow">{staff ? 'Confirmed transactions' : 'Secure checkout'}</div>
          <h2>{staff ? 'Payment transactions' : 'Make a payment'}</h2>
          <p className="muted">{staff
            ? 'Online and savings-funded member payments appear here. Members can see only their own transactions.'
            : 'Choose what to pay and whether to use Xendit or your available savings balance.'}</p>
        </div>}
      </div>
      <PortalMessage error>{error || actionError}</PortalMessage>
      <PortalMessage>{notice}</PortalMessage>
      {!staff && (
        <div className="portal-card payment-instructions">
          <h3>{effectivePaymentMethod === 'xendit' ? 'Pay securely with Xendit' : 'Pay from your savings balance'}</h3>
          <p>{effectivePaymentMethod === 'xendit'
            ? 'Complete payment on Xendit’s secure checkout page. CoopWise updates your account only after the backend verifies Xendit’s payment confirmation.'
            : 'The amount is deducted from your available savings and applied to the selected payment immediately. No external transfer is made.'}</p>
          <strong>Available savings: {savingsBalance === undefined || savingsBalance === null ? 'Loading…' : formatPesos(savingsBalance / 100)}</strong>
        </div>
      )}
      {!staff && (
        <form className="portal-card form-grid" key={replacementPayment?.transaction_id || 'new-payment'} onSubmit={startCheckout}>
          <label>Payment method
            <select name="payment_method" value={purpose === 'savings' ? 'xendit' : paymentMethod} disabled={purpose === 'savings'} onChange={(event) => setPaymentMethod(event.target.value)} required>
              <option value="xendit">Xendit checkout</option>
              <option value="savings">Deduct from savings</option>
            </select>
          </label>
          <label>Payment for
            <select value={purpose} onChange={(event) => setPurpose(event.target.value)} required>
              <option value="loan">Loan repayment</option>
              <option value="paluwagan">Paluwagan contribution</option>
              <option value="share_capital">Share-capital contribution</option>
              <option value="savings">Deposit to savings</option>
            </select>
          </label>
          {purpose === 'loan' && (
            <label>Loan
              <select name="loan_id" required defaultValue={replacementPayment?.loan_id || ''}>
                <option value="" disabled>Select a loan</option>
                {loans.filter((loan) => ['approved', 'active'].includes(loan.status)).map((loan) => <option key={loan.id} value={loan.id}>{loan.loan_code} · Balance PHP {loan.current_balance}</option>)}
              </select>
            </label>
          )}
          {purpose === 'paluwagan' && (
            <label>Active Paluwagan cycle
              <select name="cycle_id" required defaultValue={replacementPayment?.cycle_id || ''}>
                <option value="" disabled>Select a cycle</option>
                {cycles.filter((cycle) => cycle.status === 'active' && !cycle.my_contributed_today).map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name} · PHP {cycle.daily_contribution} daily</option>)}
              </select>
            </label>
          )}
          {purpose === 'share_capital' && (
            <label>Share subscription
              <select name="subscription_id" required defaultValue={replacementPayment?.subscription_id || ''}>
                <option value="" disabled>Select an unpaid subscription</option>
                {subscriptions.filter((item) => item.status === 'active' && Number(item.unpaid_amount) > 0).map((item) => <option key={item.id} value={item.id}>{item.subscription_number} · Unpaid {formatPesos(item.unpaid_amount)}</option>)}
              </select>
            </label>
          )}
          <label>Amount (PHP)<input name="amount" type="number" min="1.00" max="1000000.00" step="0.01" required defaultValue={replacementPayment?.amount || ''} /></label>
          {purpose === 'savings' && <p className="full muted">The balance is credited only after Xendit Test Mode confirms the checkout. This does not move real money.</p>}
          {purpose === 'paluwagan' && <p className="full muted">The amount must equal the selected cycle’s daily contribution. Only one payment is accepted per member per day.</p>}
          <button className="button button-primary full" type="submit" disabled={submitting}>{submitting
            ? (effectivePaymentMethod === 'xendit' ? 'Opening secure checkout…' : 'Processing savings payment…')
            : (purpose === 'savings' ? 'Continue to Xendit Test Mode' : effectivePaymentMethod === 'xendit' ? 'Continue to Xendit' : 'Pay from savings')}</button>
          {submitting && effectivePaymentMethod === 'xendit' && <p className="full muted" role="status">{slowCheckout
            ? 'The payment service is taking longer than usual to respond. Please wait; do not click again. No payment is taken until you complete Xendit checkout.'
            : 'Connecting securely to Xendit. Please wait before leaving this page.'}</p>}
        </form>
      )}
      <div className="item-heading"><h3>{staff ? 'All member transactions' : 'Your transactions'}</h3>
        <button className="button button-outline" type="button" onClick={() => window.dispatchEvent(new Event('coopwise:refresh'))}>Refresh</button>
      </div>
      {loading && <StaffEmptyState type="payment" title="Loading transactions…" description="Please wait while we check recent payment records." loading />}
      {!loading && !error && transactions.length === 0 && <StaffEmptyState type="payment" title="No payment transactions yet." description="Completed Xendit payments, savings deposits, and savings-funded payments will appear here." />}
      {transactions.length > 0 && <div className="table-wrap"><table>
        <thead><tr>{staff && <th>Member</th>}<th>Date</th><th>Purpose</th><th>Amount</th><th>Payment method</th>{staff && <th>Provider fee / net</th>}<th>Reference</th><th>Status</th>{!staff && <th>Action</th>}</tr></thead>
        <tbody>{transactions.map((transaction) => <tr key={transaction.id}>
          {staff && <td>{transaction.member_number} · {transaction.first_name} {transaction.last_name}</td>}
          <td>{transaction.paid_at || transaction.created_at}</td>
          <td>{transaction.purpose === 'savings' ? 'Savings deposit' : transaction.purpose.replace('_', ' ')}</td>
          <td>{formatPesos(transaction.amount)}</td>
          <td>{transaction.payment_method === 'savings' ? 'Savings balance' : 'Xendit'}</td>
          {staff && <td>{transaction.provider_fee === null ? '—' : `${formatPesos(transaction.provider_fee)} fee · ${formatPesos(transaction.net_amount)} net`}</td>}
          <td>{transaction.reference_no}</td>
          <td><span className={`status status-${transaction.status}`}>{transaction.status.replace('_', ' ')}</span>
            {transaction.review_note && <small>{transaction.review_note}</small>}</td>
          {!staff && <td>{['pending', 'needs_review'].includes(transaction.status) && <>
            {transaction.checkout_url && <a className="text-button" href={transaction.checkout_url} target="_blank" rel="noreferrer">Open checkout</a>}
            <button className="text-button" type="button" disabled={checkingPayment === transaction.id} onClick={() => refreshPayment(transaction)}>{checkingPayment === transaction.id ? 'Checking…' : 'Check status'}</button>
            {transaction.status === 'pending' && transaction.payment_method === 'xendit' && <button className="text-button" type="button" disabled={cancellingPayment === transaction.id || checkingPayment === transaction.id} onClick={() => cancelAndSwitchToSavings(transaction)}>{cancellingPayment === transaction.id ? 'Cancelling…' : 'Cancel & switch to savings'}</button>}
          </>}</td>}
        </tr>)}</tbody>
      </table></div>}
      {transactionsPagination && <div className="pagination-controls" aria-label="Payment history pages">
        <button className="button button-outline" type="button" disabled={transactionsPage <= 1 || loading} onClick={() => setTransactionsPage((page) => page - 1)}>Previous</button>
        <span>Page {transactionsPage}</span>
        <button className="button button-outline" type="button" disabled={!transactionsPagination.has_more || loading} onClick={() => setTransactionsPage((page) => page + 1)}>Next</button>
      </div>}
    </section>
  )
}

const STAFF_NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'learning', label: 'Co-op Guide', icon: 'learning' },
  { id: 'demo-guide', label: 'Demo Walkthrough', icon: 'guide' },
  { id: 'savings', label: 'Savings', icon: 'savings' },
  { id: 'loans', label: 'Loans', icon: 'loans' },
  { id: 'cooperative', label: 'Daily Paluwagan', icon: 'cooperative' },
  { id: 'share-capital', label: 'Share Capital', icon: 'share-capital' },
  { id: 'payments', label: 'Transactions', icon: 'payments' },
  { id: 'members', label: 'Members', icon: 'members' },
  { id: 'reports', label: 'Reports', icon: 'reports' },
]

const MEMBER_NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'learning', label: 'Co-op Guide', icon: 'learning' },
  { id: 'demo-guide', label: 'Demo Walkthrough', icon: 'guide' },
  { id: 'loans', label: 'Loans', icon: 'loans' },
  { id: 'share-capital', label: 'Share Capital', icon: 'share-capital' },
  { id: 'payments', label: 'Online Payments', icon: 'payments' },
  { id: 'cooperative', label: 'Daily Paluwagan', icon: 'cooperative' },
  { id: 'savings', label: 'Savings', icon: 'savings' },
]

const STAFF_PAGE_DETAILS = {
  dashboard: ['Dashboard', 'Manage cooperative services and member activity.'],
  learning: ['Cooperative Learning Center', 'Explain membership, share capital, loans, Paluwagan, and demo balance rules.'],
  'demo-guide': ['Guided Demo Walkthrough', 'Show the main cooperative flow using examples without changing database records.'],
  loans: ['Loans', 'Review loan documents, applications, and available loan offers.'],
  'share-capital': ['Share Capital', 'Track member ownership subscriptions and paid-up contributions.'],
  reports: ['Reports', 'View recorded cooperative totals and monthly activity.'],
  payments: ['Payment Transactions', 'Review provider-confirmed payments from members.'],
  cooperative: ['Daily Paluwagan', 'Members contribute through Xendit checkout. Staff confirm the payout and add it to the recipient’s available balance.'],
  savings: ['Savings', 'Review member balances funded by approved loans and completed Paluwagan payouts.'],
  members: ['Members', 'Member directory and account status.'],
}

const MEMBER_PAGE_DETAILS = {
  dashboard: ['Dashboard', 'Your cooperative services, all in one place.'],
  learning: ['Cooperative Learning Center', 'Learn how the cooperative and its services work.'],
  'demo-guide': ['Guided Demo Walkthrough', 'Explore the example flow without changing your account records.'],
  loans: ['Loans', 'Review your loan documents, offers, and applications.'],
  'share-capital': ['Share Capital', 'View your ownership subscriptions and paid-up contributions.'],
  payments: ['Payments', 'Pay cooperative dues through Xendit and view transaction history.'],
  cooperative: ['Daily Paluwagan', 'Pay the agreed contribution through Xendit. Once staff confirm the pooled payout, it is added to the recipient’s available balance.'],
  savings: ['Savings', 'View your available demo balance and transaction history.'],
}

function StaffIcon({ name }) {
  const paths = {
    dashboard: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
    loans: <><path d="M4 5.5h16M4 10h16M4 14.5h10" /><path d="M17 14v6m-3-3h6" /></>,
    reports: <><path d="M4 20V11m5 9V5m5 15v-7m5 7V3" /><path d="M2.5 20.5h19" /></>,
    payments: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18m-14 5h4" /></>,
    learning: <><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H20v17H7.5A3.5 3.5 0 0 0 4 22z" /><path d="M4 5.5v13A3.5 3.5 0 0 1 7.5 15H20M8 6h8m-8 4h6" /></>,
    guide: <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
    cooperative: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
    savings: <><path d="M19.5 9.5c-1.6-2.4-4.1-3.5-7.5-3.5-4.7 0-8 2.5-8 6s3.3 6 8 6c3.4 0 5.9-1.1 7.5-3.5" /><path d="M18 10h3v4h-3m-7-2h.01" /></>,
    members: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20v-1.5A5.5 5.5 0 0 1 9 13h1a5.5 5.5 0 0 1 5.5 5.5V20z" /><path d="M16 5.5a3 3 0 0 1 0 5.8m2 2a5 5 0 0 1 2.5 4.3V20" /></>,
    'share-capital': <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M15.5 9.5c0-1.4-1.4-2.5-3.5-2.5S8.5 8.1 8.5 9.5 10 11.5 12 12s3.5 1.1 3.5 2.5S14 17 12 17s-3.5-1.1-3.5-2.5" /></>,
  }
  return <svg className="staff-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function ServiceDashboard({ token, user, staff, selectedTab, setSelectedTab, refreshKey, paymentInitialPurpose, onSavingsDeposit, resetPaymentPurpose }) {
  const [memberCardOpen, setMemberCardOpen] = useState(false)
  const tabs = [
    { id: 'savings', label: 'Savings' },
    { id: 'loans', label: 'Loans' },
    { id: 'cooperative', label: 'Daily Paluwagan' },
    { id: 'share-capital', label: 'Share capital' },
    { id: 'payments', label: staff ? 'Transactions' : 'Payments' },
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
            onClick={() => {
              if (tab.id === 'payments') resetPaymentPurpose()
              setSelectedTab(tab.id)
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {selectedTab === 'loans'
        ? <LoanPortal key="dashboard-loans" token={token} user={user} refreshKey={refreshKey} />
        : selectedTab === 'members'
          ? <MembersPortal key="dashboard-members" token={token} />
          : selectedTab === 'share-capital'
            ? <ShareCapitalPortal key="dashboard-share-capital" token={token} user={user} refreshKey={refreshKey} />
          : selectedTab === 'savings'
            ? <SavingsPortal key="dashboard-savings" token={token} user={user} refreshKey={refreshKey} onDeposit={onSavingsDeposit} />
            : selectedTab === 'cooperative'
              ? <CooperativePortal key="dashboard-cooperative" token={token} user={user} refreshKey={refreshKey} />
              : selectedTab === 'payments'
                ? <PaymentPortal key={`dashboard-payments-${paymentInitialPurpose}`} token={token} user={user} refreshKey={refreshKey} initialPurpose={paymentInitialPurpose} />
                : <ReportsPortal key="dashboard-reports" token={token} refreshKey={refreshKey} />}
      {memberCardOpen && <MemberIdCardDialog token={token} memberId={null} onClose={() => setMemberCardOpen(false)} />}
    </>
  )
}

function StaffWorkspace({ token, user, section, setSection, refreshKey, onSignOut, theme, onToggleTheme }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dashboardTab, setDashboardTab] = useState('savings')
  const [paymentInitialPurpose, setPaymentInitialPurpose] = useState('loan')
  const staff = ['admin', 'officer'].includes(user.role)
  const navItems = staff ? STAFF_NAV_ITEMS : MEMBER_NAV_ITEMS
  const pageDetails = staff ? STAFF_PAGE_DETAILS : MEMBER_PAGE_DETAILS
  const [pageTitle, pageDescription] = pageDetails[section] || pageDetails.dashboard
  const initials = user.full_name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()

  function navigate(nextSection) {
    if (nextSection === 'payments') setPaymentInitialPurpose('loan')
    setSection(nextSection)
    setSidebarOpen(false)
  }

  function openSavingsDeposit() {
    setPaymentInitialPurpose('savings')
    if (section === 'dashboard') {
      setDashboardTab('payments')
    } else {
      setSection('payments')
      setSidebarOpen(false)
    }
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
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
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
            ? <ServiceDashboard
              token={token}
              user={user}
              staff={staff}
              selectedTab={dashboardTab}
              setSelectedTab={setDashboardTab}
              refreshKey={refreshKey}
              paymentInitialPurpose={paymentInitialPurpose}
              onSavingsDeposit={openSavingsDeposit}
              resetPaymentPurpose={() => setPaymentInitialPurpose('loan')}
            />
            : section === 'learning'
              ? <LearningCenter key="learning" token={token} user={user} refreshKey={refreshKey} standalone />
            : section === 'demo-guide'
              ? <DemoGuide key="demo-guide" setSection={navigate} standalone />
            : section === 'loans'
              ? <LoanPortal key="loans" token={token} user={user} refreshKey={refreshKey} standalone />
              : section === 'share-capital'
                ? <ShareCapitalPortal key="share-capital" token={token} user={user} refreshKey={refreshKey} standalone />
              : section === 'members'
                ? <MembersPortal key="members" token={token} standalone />
                : section === 'savings'
                  ? <SavingsPortal key="savings" token={token} user={user} refreshKey={refreshKey} standalone onDeposit={openSavingsDeposit} />
                  : section === 'cooperative'
                    ? <CooperativePortal key="cooperative" token={token} user={user} refreshKey={refreshKey} standalone />
                    : section === 'payments'
                      ? <PaymentPortal key={`payments-${paymentInitialPurpose}`} token={token} user={user} refreshKey={refreshKey} standalone initialPurpose={paymentInitialPurpose} />
                      : <ReportsPortal key="reports" token={token} refreshKey={refreshKey} standalone />}
        </div>
        <footer className="staff-footer">Xendit confirms incoming payments. Confirmed Paluwagan payouts are credited to the recipient’s demo balance.</footer>
      </div>
    </div>
  )
}

function App() {
  const [theme, setTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem('coopwise_theme')
    return savedTheme === 'dark' ? 'dark' : 'light'
  })
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
  const [resetEmail, setResetEmail] = useState('')
  const [sessionError, setSessionError] = useState('')
  const [sessionAttempt, setSessionAttempt] = useState(0)
  const [authConfig, setAuthConfig] = useState(null)
  const [authConfigError, setAuthConfigError] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileError, setTurnstileError] = useState('')
  const [turnstileResetKey, setTurnstileResetKey] = useState(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
    window.localStorage.setItem('coopwise_theme', theme)
    window.dispatchEvent(new Event('coopwise:theme-change'))
  }, [theme])

  function toggleTheme() {
    setTheme((currentTheme) => currentTheme === 'dark' ? 'light' : 'dark')
  }

  useEffect(() => {
    let active = true
    apiRequest('/auth/config')
      .then((config) => {
        if (active) setAuthConfig(config)
      })
      .catch((requestError) => {
        if (active) setAuthConfigError(requestError.message)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!token || memberCardToken) return
    let active = true
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 15000)
    apiRequest('/me', { token, signal: controller.signal })
      .then((result) => {
        if (!active) return
        setUser(result.user)
        setSection('dashboard')
        setAuthenticating(false)
      })
      .catch((requestError) => {
        if (!active) return
        setAuthenticating(false)
        if (requestError.status === 401) {
          expireSession()
        } else {
          setSessionError(
            requestError.name === 'TimeoutError' || requestError.name === 'AbortError'
              ? 'The server took too long to check your saved session. Check your connection or try again.'
              : requestError.message || 'Your session could not be checked. Check your connection and try again.'
          )
        }
      })
      .finally(() => window.clearTimeout(timeoutId))
    return () => {
      active = false
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [token, memberCardToken, sessionAttempt])

  useEffect(() => {
    const refresh = () => {
      invalidatePortalDataCache()
      setRefreshKey((key) => key + 1)
    }
    window.addEventListener('coopwise:refresh', refresh)
    return () => window.removeEventListener('coopwise:refresh', refresh)
  }, [])

  useEffect(() => {
    const expired = () => {
      invalidatePortalDataCache()
      setToken(null)
      setUser(null)
      setAuthenticating(false)
      setSessionError('')
      setMode('login')
      setMessage('Your session expired. Please sign in again.')
    }
    window.addEventListener('coopwise:session-expired', expired)
    return () => window.removeEventListener('coopwise:session-expired', expired)
  }, [])

  function finishSignIn(result) {
    sessionStorage.setItem('coopwise_access_token', result.access_token)
    sessionStorage.setItem('coopwise_refresh_token', result.refresh_token)
    setToken(result.access_token)
    setUser(result.user)
    setSessionError('')
    setSection('dashboard')
  }

  function clearSavedSession() {
    invalidatePortalDataCache()
    sessionStorage.removeItem('coopwise_access_token')
    sessionStorage.removeItem('coopwise_refresh_token')
    setToken(null)
    setUser(null)
    setAuthenticating(false)
    setSessionError('')
    setMode('login')
    setMessage('Your saved session was cleared. Sign in again.')
  }

  function switchAuthMode(nextMode) {
    setMode(nextMode)
    setMessage('')
    setFieldErrors({})
    setTurnstileToken('')
    setTurnstileError('')
    setTurnstileResetKey((key) => key + 1)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (authConfig?.turnstile_configuration_incomplete) {
      setMessage('The sign-in security check is not configured correctly. Contact cooperative staff.')
      return
    }
    if (authConfig?.turnstile_enabled && !turnstileToken) {
      setMessage('Complete the security check before continuing.')
      return
    }
    setBusy(true)
    setMessage('')
    setFieldErrors({})
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    values.turnstile_token = turnstileToken
    try {
      if (mode === 'register') {
        await apiRequest('/auth/register', { method: 'POST', body: JSON.stringify(values) })
        switchAuthMode('login')
        setMessage('Registration complete. Sign in with your email or phone number.')
      } else if (mode === 'forgot') {
        const result = await apiRequest('/auth/password-reset/request', {
          method: 'POST',
          body: JSON.stringify({
            email: values.email,
            turnstile_token: values.turnstile_token,
          }),
        })
        setResetEmail(values.email.trim())
        switchAuthMode('reset')
        setMessage(`${result.message} Enter the code if you receive it. It expires in 10 minutes.`)
      } else if (mode === 'reset') {
        const result = await apiRequest('/auth/password-reset/confirm', {
          method: 'POST',
          body: JSON.stringify(values),
        })
        switchAuthMode('login')
        setMessage(result.message)
      } else {
        const result = await apiRequest('/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            login: values.login,
            password: values.password,
            turnstile_token: values.turnstile_token,
          }),
        })
        finishSignIn(result)
      }
    } catch (requestError) {
      setMessage(requestError.message)
      setFieldErrors(requestError.fields || {})
    } finally {
      setBusy(false)
      setTurnstileToken('')
      setTurnstileResetKey((key) => key + 1)
    }
  }

  async function handleGoogleCredential(idToken) {
    if (busy) return
    if (authConfig?.turnstile_configuration_incomplete) {
      setMessage('The sign-in security check is not configured correctly. Contact cooperative staff.')
      return
    }
    if (authConfig?.turnstile_enabled && !turnstileToken) {
      setMessage('Complete the security check before continuing with Google.')
      return
    }
    setBusy(true)
    setMessage('')
    setFieldErrors({})
    try {
      const result = await apiRequest('/auth/google', {
        method: 'POST',
        body: JSON.stringify({
          id_token: idToken,
          turnstile_token: turnstileToken,
        }),
      })
      finishSignIn(result)
    } catch (requestError) {
      setMessage(requestError.message)
      setFieldErrors(requestError.fields || {})
    } finally {
      setBusy(false)
      setTurnstileToken('')
      setTurnstileResetKey((key) => key + 1)
    }
  }

  async function signOut() {
    if (!window.confirm('Are you sure you want to sign out?')) return
    const refreshToken = sessionStorage.getItem('coopwise_refresh_token')
    let revokeError = ''
    if (refreshToken) {
      try {
        await apiRequest('/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refresh_token: refreshToken }),
        })
      } catch (requestError) {
        revokeError = requestError.message
      }
    }
    invalidatePortalDataCache()
    sessionStorage.removeItem('coopwise_access_token')
    sessionStorage.removeItem('coopwise_refresh_token')
    setToken(null)
    setUser(null)
    setMode('login')
    setMessage(revokeError
      ? `Signed out on this device. The server could not revoke the session: ${revokeError}`
      : 'You have signed out.')
  }

  if (memberCardToken) return <MemberCardVerification verificationToken={memberCardToken} theme={theme} onToggleTheme={toggleTheme} />

  return (
    <main className={`page-shell${user ? ' page-shell-staff' : ''}`}>
      {user ? (
        <StaffWorkspace token={token} user={user} section={section} setSection={setSection} refreshKey={refreshKey} onSignOut={signOut} theme={theme} onToggleTheme={toggleTheme} />
      ) : (
        <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="CoopWise home">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 27C4 15 11 7 27 5c-1 14-8 22-21 22Z" fill="currentColor" /><path d="M8 27c4-7 9-12 16-17" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" /></svg>
          <span>Coop<span>Wise</span></span>
        </a>
        <div className="topbar-actions">
          <span className="tagline">Cooperative services, made clear</span>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
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
            <p>Sign in to manage your loans, savings, Paluwagan contributions, and payment transactions.</p>
          </div>

          <div className="card auth-card">
            {sessionError && token && <div className="message message-error" role="alert">
              <p>{sessionError}</p>
              <div className="button-row">
                <button className="text-button" type="button" onClick={() => {
                  setSessionError('')
                  setAuthenticating(true)
                  setSessionAttempt((attempt) => attempt + 1)
                }}>Retry session</button>
                <button className="text-button" type="button" onClick={clearSavedSession}>Clear saved session and sign in</button>
              </div>
            </div>}
            <div className="tabs" role="tablist" aria-label="Account options">
              <button className={mode === 'login' ? 'tab active' : 'tab'} type="button" onClick={() => switchAuthMode('login')}>Sign in</button>
              <button className={mode === 'register' ? 'tab active' : 'tab'} type="button" onClick={() => switchAuthMode('register')}>Register</button>
            </div>
            <h2>{mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Create your member account' : mode === 'forgot' ? 'Reset your password' : 'Enter your reset code'}</h2>
            {message && <div className="message" role="status">{message}</div>}
            {authConfigError && <div className="message message-error" role="alert">Sign-in provider settings could not be loaded: {authConfigError}</div>}
            {authConfig?.turnstile_configuration_incomplete && <div className="message message-error" role="alert">The Turnstile site key and secret key both need to be configured before this security check can be used.</div>}
            {turnstileError && <div className="message message-error" role="alert">{turnstileError}</div>}
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
              ) : mode === 'login' ? (
                <>
                  <label>Email or phone number<input name="login" autoComplete="username" required placeholder="Email address or 09123456789" /></label>
                  <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
                </>
              ) : mode === 'forgot' ? (
                <label>Email address<input name="email" type="email" autoComplete="email" required maxLength="254" /></label>
              ) : (
                <>
                  <label>Email address<input name="email" type="email" autoComplete="email" value={resetEmail} onChange={(event) => setResetEmail(event.target.value)} required maxLength="254" /></label>
                  <label>Six-digit code<input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" required /></label>
                  <label>New password<input name="password" type="password" autoComplete="new-password" required minLength="8" maxLength="128" /></label>
                  <label>Confirm new password<input name="password_confirmation" type="password" autoComplete="new-password" required minLength="8" maxLength="128" /></label>
                  <p className="form-help full">Use 8-128 characters with an uppercase letter, a number, a special character, and no spaces.</p>
                </>
              )}
              {authConfig?.turnstile_enabled && <div className="auth-security-check full">
                <span className="form-help">Complete the security check to continue.</span>
                <TurnstileWidget
                  key={`${mode}-${turnstileResetKey}`}
                  siteKey={authConfig.turnstile_site_key}
                  action={mode === 'register' ? 'register' : mode === 'forgot' ? 'password_reset_request' : mode === 'reset' ? 'password_reset_confirm' : 'login'}
                  resetKey={turnstileResetKey}
                  onToken={setTurnstileToken}
                  onLoadError={setTurnstileError}
                />
              </div>}
              <button className="button button-primary submit" type="submit" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset code' : 'Change password'}
              </button>
            </form>
            {mode === 'login' && authConfig?.google_client_id && <div className="google-signin-section">
              <span className="google-signin-divider">or</span>
              <GoogleSignInButton
                clientId={authConfig.google_client_id}
                disabled={busy}
                onCredential={handleGoogleCredential}
                onLoadError={setTurnstileError}
              />
              <small className="form-help">Google sign-in is available for existing active member accounts with a matching verified email.</small>
            </div>}
            {mode === 'login' && <button className="text-button auth-reset-link" type="button" onClick={() => switchAuthMode('forgot')}>Forgot password?</button>}
            {(mode === 'forgot' || mode === 'reset') && <button className="text-button auth-reset-link" type="button" onClick={() => switchAuthMode('login')}>Back to sign in</button>}
            {mode === 'register' && <p className="form-help">Names use letters and spaces. Use an 11-digit number starting with 09. Passwords require 8+ characters, one uppercase letter, one number, one special character, and no spaces.</p>}
          </div>
        </section>
      )}
      <footer>Incoming payments use Xendit checkout and require server-side confirmation.</footer>
        </>
      )}
    </main>
  )
}

export default App
