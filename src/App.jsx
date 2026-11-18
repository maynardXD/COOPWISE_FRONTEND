import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

/* This is the main screen of CoopWise. It shows the pages and connects them to the backend. */
const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost/COOPWISE/LavaLust-COOPWISE/api').replace(/\/+$/, '')
const TODAY = new Date().toISOString().slice(0, 10)
const LOAN_ENDPOINTS = ['/loan-products', '/loans', '/payments', '/loan-readiness', '/loans/eligibility']
const COOPWISE_TERMS_VERSION = '2026-11-17'
const PAYMENT_ENDPOINTS = ['/loans', '/cooperative/cycles', '/share-capital', '/checkout-transactions', '/savings']
const SHARE_CAPITAL_ENDPOINTS = ['/share-capital', '/cooperative/finance']
const REPORT_ENDPOINTS = ['/reports']
const POLICY_ENDPOINTS = ['/cooperative/policies']
const PORTAL_CACHE_MAX_AGE_MS = 15_000
const portalDataCache = new Map()
let portalCacheRevision = 0
let googleChartsPromise = null
let googleIdentityPromise = null
let turnstilePromise = null

// This block lets the user switch between light and dark mode.
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
    >{/* BUTTON - switch to day or night mode. */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {dark
          ? <><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>
          : <><path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z" /></>}
      </svg>
      <span>{dark ? 'Day' : 'Night'} mode</span>
    </button>
  )
}

// These helpers load outside services only when a page needs them.
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

// This block loads the chart library for report graphs.
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

// This block loads Google's sign-in helper.
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

// This block loads the sign-in security check.
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

// This block clears saved page data after a change.
function invalidatePortalDataCache() {
  portalCacheRevision += 1
  portalDataCache.clear()
}

// This key keeps each account's saved page data separate.
function portalCacheKey(token, endpoint) {
  return `${token || 'anonymous'}:${endpoint}`
}

// This block checks whether saved page data is still fresh.
function readPortalCache(token, endpoints) {
  const cached = endpoints.map((endpoint) => portalDataCache.get(portalCacheKey(token, endpoint)))
  if (!cached.some(Boolean)) return null
  return {
    data: cached.map((entry) => entry?.data ?? null),
    fresh: cached.every((entry) => entry && Date.now() - entry.savedAt < PORTAL_CACHE_MAX_AGE_MS),
  }
}

// This block combines page request errors into a readable message.
function summarizePortalErrors(results) {
  const groupedErrors = new Map()
  results.forEach(({ error }) => {
    if (!error) return
    const separator = error.indexOf(': ')
    const path = separator < 0 ? '' : error.slice(0, separator)
    const message = separator < 0 ? error : error.slice(separator + 2)
    const group = groupedErrors.get(message) || { paths: [], message }
    if (path) group.paths.push(path)
    groupedErrors.set(message, group)
  })

  return [...groupedErrors.values()]
    .map(({ paths, message }) => paths.length > 1 || !paths.length
      ? message
      : `${paths[0]}: ${message}`)
    .join(' · ')
}

// This helper sends one request to the backend and reports any error.
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

// These checks stop letters and invalid pasted values in fields that need numbers.
function enforceNumericKey(event) {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.type !== 'number') return
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return
  const integerOnly = input.step === '1'
  if (!/[0-9]/.test(event.key) && !(event.key === '.' && !integerOnly && !input.value.includes('.'))) {
    event.preventDefault()
  }
}

// This block stops invalid text from being pasted into number-only fields.
function enforceNumericPaste(event) {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.type !== 'number') return
  const value = event.clipboardData?.getData('text') || ''
  const integerOnly = input.step === '1'
  if (!/^\d+$/.test(value) && !(!integerOnly && /^\d*(?:\.\d*)?$/.test(value))) {
    event.preventDefault()
  }
}

// This block stops invalid text from being dropped into number-only fields.
function enforceNumericDrop(event) {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.type !== 'number') return
  const value = event.dataTransfer?.getData('text') || ''
  const integerOnly = input.step === '1'
  if (!/^\d+$/.test(value) && !(!integerOnly && /^\d*(?:\.\d*)?$/.test(value))) {
    event.preventDefault()
  }
}

// This block keeps number-only fields from accepting invalid values.
function enforceNumericInput(event) {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.type !== 'number') return
  const value = event.nativeEvent?.data
  if (value === null || value === undefined) return
  const integerOnly = input.step === '1'
  if (!/^\d+$/.test(value) && !(!integerOnly && /^\d*(?:\.\d*)?$/.test(value))) {
    event.preventDefault()
  }
}

let refreshRequest = null

// These helpers keep the member signed in safely and refresh the session when needed.
function expireSession() {
  sessionStorage.removeItem('coopwise_access_token')
  sessionStorage.removeItem('coopwise_refresh_token')
  window.dispatchEvent(new Event('coopwise:session-expired'))
}

// This block gets a fresh access token for the signed-in user.
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

// This block shows the sign-in security check.
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

// This block shows the Google sign-in button.
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

// This hook loads data for a page and shows loading or error information to the screen.
function usePortalData(token, refreshKey, endpoints) {
  const [data, setData] = useState(() => readPortalCache(token, endpoints)?.data || null)
  const [error, setError] = useState('')
  const requestKey = `${token || 'anonymous'}:${refreshKey}:${endpoints.join('|')}`
  const [completedRequestKey, setCompletedRequestKey] = useState(null)
  const loading = !readPortalCache(token, endpoints)?.fresh && completedRequestKey !== requestKey
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
          setCompletedRequestKey(requestKey)
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
          setError(summarizePortalErrors(results))
        }
      })
      .finally(() => {
        if (active) setCompletedRequestKey(requestKey)
      })
    return () => { active = false }
  }, [token, refreshKey, endpoints, requestKey])

  const refreshEndpoint = useCallback(async (endpoint, requestOptions = {}) => {
    const index = endpoints.indexOf(endpoint)
    if (index < 0) return
    const requestRevision = portalCacheRevision
    const result = await apiRequest(endpoint, { ...requestOptions, token })
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

// This block shows a message or error on a portal page.
function PortalMessage({ children, error = false }) {
  return children ? <div className={error ? 'message message-error' : 'message'} role="status">{children}</div> : null
}

// This block shows a floating action message that closes after ten seconds.
function ActionToast({ message, onDismiss }) {
  useEffect(() => {
    if (!message) return undefined
    const timer = window.setTimeout(() => onDismiss(''), 10000)
    return () => window.clearTimeout(timer)
  }, [message, onDismiss])

  if (!message) return null

  return (
    <div className="action-toast-viewport" aria-live="polite" aria-atomic="true">
      <div className="action-toast" key={message} role="status">
        <span className="action-toast-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none"><path d="m5 10 3.2 3.2L15.5 6" /></svg>
        </span>
        <p>{message}</p>
        <button className="action-toast-dismiss" type="button" onClick={() => onDismiss('')} aria-label="Dismiss notification">{/* BUTTON - dismisses the notification. */}
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
        <span className="action-toast-timer" aria-hidden="true" />
      </div>
    </div>
  )
}

// This event sends success messages from any tab to the shared toast.
function dispatchActionToast(message) {
  window.dispatchEvent(new CustomEvent('coopwise:action-toast', { detail: { message } }))
}

// This block shows what to expect when a list has no records.
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

// This block shows a placeholder while page records are loading.
function PortalSkeleton({ kind = 'table', rows = 4, columns = 5, label = 'Loading records' }) {
  const rowIndexes = Array.from({ length: rows }, (_, index) => index)
  const columnIndexes = Array.from({ length: columns }, (_, index) => index)

  return (
    <div className={`portal-skeleton portal-skeleton-${kind}`} role="status" aria-busy="true" aria-label={label}>
      <div className="portal-skeleton-content" aria-hidden="true">
        {kind === 'cards'
          ? rowIndexes.map((row) => (
            <article className="portal-skeleton-card" key={row}>
              <div className="portal-skeleton-card-heading"><span className="portal-skeleton-bar" /><span className="portal-skeleton-bar" /></div>
              <span className="portal-skeleton-bar portal-skeleton-bar-wide" />
              <div className="portal-skeleton-card-lines">
                <span className="portal-skeleton-bar" /><span className="portal-skeleton-bar" />
                <span className="portal-skeleton-bar" /><span className="portal-skeleton-bar" />
              </div>
              <span className="portal-skeleton-bar portal-skeleton-bar-action" />
            </article>
          ))
          : kind === 'metrics'
            ? <div className="portal-skeleton-metrics">{rowIndexes.map((row) => (
              <article className="portal-skeleton-card" key={row}>
                <span className="portal-skeleton-bar" />
                <span className="portal-skeleton-bar portal-skeleton-bar-value" />
                <span className="portal-skeleton-bar portal-skeleton-bar-short" />
              </article>
            ))}</div>
            : <div className="portal-skeleton-table table-wrap">
              <table>
                <thead><tr>{columnIndexes.map((column) => <th key={column}><span className="portal-skeleton-bar" /></th>)}</tr></thead>
                <tbody>{rowIndexes.map((row) => (
                  <tr key={row}>{columnIndexes.map((column) => <td key={column}><span className="portal-skeleton-bar" /></td>)}</tr>
                ))}</tbody>
              </table>
            </div>}
      </div>
    </div>
  )
}

// This block formats an amount as Philippine pesos.
function formatPesos(value) {
  const amount = Number(value || 0)
  return `PHP ${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// This block makes a ledger description easier to read.
function formatLedgerDescription(description) {
  const formalDescriptions = {
    'Xendit Test Mode deposit confirmed by provider': 'Online savings deposit confirmed by payment provider.',
  }
  return formalDescriptions[description] || description
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

  // This block shows the heading and actions for a portal page.
  function drawPageHeader() {
    pdf.setTextColor(25, 68, 51)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(16)
    pdf.text('CoopWise Member Savings Statement', margin, 16)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(9)
    pdf.text(`Member: ${safeText(ledger.member.full_name)}  |  Member number: ${safeText(ledger.member.member_number)}`, margin, 23)
    pdf.text(`Status: ${safeText(ledger.member.status)}  |  Period: ${ledger.period.from} to ${ledger.period.to}  |  Generated: ${ledger.generated_at}`, margin, 29)

    const summary = [
      ['Balance at period start', ledger.opening_balance],
      ['Deposits and credits', ledger.deposits_total],
      ['Withdrawals and debits', ledger.withdrawals_total],
      ['Balance at period end', ledger.closing_balance],
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
    ['Balance at period start', '-', 'Balance before the selected period', '-', '-', formatPesos(ledger.opening_balance)],
    ...ledger.transactions.map((transaction) => [
      transaction.created_at,
      transaction.reference_no,
      formatLedgerDescription(transaction.description || (transaction.type === 'deposit' ? 'Savings deposit' : 'Savings withdrawal')),
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

// This block formats a date using the local calendar date.
function localDateString(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// This block builds an estimated loan repayment schedule.
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

// This block checks a loan request against its offer limits.
function loanApplicationIsWithinLimits(product, eligibility, inputs) {
  const amount = Number(inputs?.amount)
  const term = Number(inputs?.term)
  const maximumAmount = Math.min(Number(product.max_amount), Number(eligibility?.max_eligible_amount || 0))
  return Number.isFinite(amount) && amount >= 0.01 && amount <= maximumAmount
    && Number.isInteger(term) && term >= 1 && term <= Number(product.max_term_months)
}

// This opens a simple print view for a record.
function printRecord() {
  const cleanUp = () => document.body.classList.remove('printing-record')
  window.addEventListener('afterprint', cleanUp, { once: true })
  document.body.classList.add('printing-record')
  window.print()
}

// These dialogs show a savings ledger or member card on top of the current page.
function SavingsLedgerDialog({ token, member, onClose }) {
  const [range, setRange] = useState({ preset: 'all', from: '', to: '' })
  const [ledger, setLedger] = useState(null)
  const [error, setError] = useState('')
  const setEmailNotice = dispatchActionToast
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
    // This block closes the open dialog when Escape is pressed.
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  // This block changes the date range shown in a report.
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

  // This block selects a saved report date range.
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
      <section className="record-modal ledger-modal" role="dialog" aria-modal="true" aria-labelledby="ledger-title">{/* SECTION - shows record-modal. */}
        <div className="record-modal-heading no-print">
          <div><span className="eyebrow">Savings record</span><h2 id="ledger-title">Savings ledger</h2></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close savings ledger">{/* BUTTON - close savings ledger. */}
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
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
          <button className="button button-primary" type="button" onClick={printRecord} disabled={!ledger || loading}>{/* BUTTON - print / save pdf. */}Print / Save PDF</button>
          <button className="button button-outline" type="button" onClick={emailLedgerPdf} disabled={!ledger || loading || emailSending}>{/* BUTTON - email pdf to member. */}
            {emailSending ? 'Emailing PDF…' : member ? "Email PDF to member's registered email" : 'Email PDF to my account'}
          </button>
        </div>
        <div className="no-print"><PortalMessage error>{emailError}</PortalMessage></div>
        {error && <PortalMessage error>{error}</PortalMessage>}
        {loading && <StaffEmptyState type="savings" title="Preparing savings ledger…" description="Loading the selected member’s transactions and balances." loading />}
        {ledger && !loading && <article className="ledger-print-area print-target">
          <header className="ledger-document-header">
            <div className="ledger-brand"><span className="ledger-brand-mark">C</span><span>CoopWise<small>Member financial record</small></span></div>
            <div className="ledger-document-title"><span>ACCOUNT RECORD</span><strong>MEMBER SAVINGS STATEMENT</strong></div>
          </header>
          <div className="ledger-member-details">
            <div><span>Member name</span><strong>{ledger.member.full_name}</strong></div>
            <div><span>Member number</span><strong>{ledger.member.member_number}</strong></div>
            <div><span>Membership status</span><strong className={`ledger-status status-${ledger.member.status}`}>{ledger.member.status}</strong></div>
            <div><span>Statement period</span><strong>{ledger.period.from} to {ledger.period.to}</strong></div>
          </div>
          <div className="ledger-summary">
            <div><span>Balance at period start</span><strong>{formatPesos(ledger.opening_balance)}</strong></div>
            <div><span>Deposits and credits</span><strong>{formatPesos(ledger.deposits_total)}</strong></div>
            <div><span>Withdrawals and debits</span><strong>{formatPesos(ledger.withdrawals_total)}</strong></div>
            <div><span>Balance at period end</span><strong>{formatPesos(ledger.closing_balance)}</strong></div>
          </div>
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead><tr><th>Date / Reference</th><th>Description</th><th>Deposit (Credit)</th><th>Withdrawal (Debit)</th><th>Balance</th></tr></thead>
              <tbody>
                <tr className="ledger-opening-row"><td colSpan="4">Balance at period start</td><td>{formatPesos(ledger.opening_balance)}</td></tr>
                {ledger.transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{transaction.created_at}<small>{transaction.reference_no}</small></td>
                    <td>{formatLedgerDescription(transaction.description || (transaction.type === 'deposit' ? 'Savings deposit' : 'Savings withdrawal'))}</td>
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
            <span>Balance at period start is calculated from transactions recorded before the selected period. This statement reflects CoopWise records; contact the cooperative to report a discrepancy.</span>
          </footer>
        </article>}
      </section>
    </div>
  )
}

// This block shows a member ID card.
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
        const { default: QRCode } = await import('qrcode')
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
    // This block closes the open dialog when Escape is pressed.
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="record-modal-backdrop">
      <section className="record-modal member-card-modal" role="dialog" aria-modal="true" aria-labelledby="member-card-title">{/* SECTION - shows record-modal. */}
        <div className="record-modal-heading no-print">
          <div><span className="eyebrow">CoopWise member services</span><h2 id="member-card-title">Member ID card</h2></div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close member ID card">{/* BUTTON - close member id card. */}×</button>
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
          <button className="button button-primary" type="button" onClick={printRecord}>{/* BUTTON - print / save pdf. */}Print / Save PDF</button>
        </div>}
      </section>
    </div>
  )
}

// This block checks and displays a member ID card.
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
      <section className="member-verification-card" aria-live="polite">{/* SECTION - shows member-verification-card. */}
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

// This page handles loan eligibility, applications, repayments, and staff loan reviews.
function LoanPortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [loansPage, setLoansPage] = useState(1)
  const [paymentsPage, setPaymentsPage] = useState(1)
  const [memberLoanHistory, setMemberLoanHistory] = useState(null)
  const [loadingMoreLoans, setLoadingMoreLoans] = useState(false)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [refreshing, setRefreshing] = useState(false)
  const [recordingLoanId, setRecordingLoanId] = useState(null)
  const [recordPaymentAmount, setRecordPaymentAmount] = useState('')
  const [deletingOfferId, setDeletingOfferId] = useState(null)
  const [staffApplicationStatus, setStaffApplicationStatus] = useState('pending')
  const [sendingLoanEmailId, setSendingLoanEmailId] = useState(null)
  const [eligibilityDetailsOpen, setEligibilityDetailsOpen] = useState(null)
  const [readinessDetailsOpen, setReadinessDetailsOpen] = useState(null)
  const endpoints = useMemo(() => LOAN_ENDPOINTS
    .map((path) => {
      if (path === '/loans') {
        const status = staff ? `&status=${encodeURIComponent(staffApplicationStatus)}` : ''
        return `${path}?page=${staff ? loansPage : 1}&per_page=${staff ? 25 : 2}${status}`
      }
      if (path === '/payments') return `${path}?page=${paymentsPage}&per_page=25`
      return path
    }), [loansPage, paymentsPage, staff, staffApplicationStatus])
  const { data, error, loading, refreshEndpoint } = usePortalData(token, refreshKey, endpoints)
  const setNotice = dispatchActionToast
  const [actionError, setActionError] = useState('')
  const [schedule, setSchedule] = useState(null)
  const [applicationInputs, setApplicationInputs] = useState({})
  const [pendingLoanApplication, setPendingLoanApplication] = useState(null)
  const [confirmingLoanApplication, setConfirmingLoanApplication] = useState(false)
  const [expandedOfferId, setExpandedOfferId] = useState(null)
  const [staffLoanTab, setStaffLoanTab] = useState(null)
  const products = data?.[0]?.products || []
  const loanCapitalBreakdown = data?.[0]?.loan_capital_breakdown
  const fetchedLoans = data?.[1]?.loans || []
  const memberLoanHistoryKey = `${refreshKey}:${token}`
  const extraMemberLoans = !staff && memberLoanHistory?.key === memberLoanHistoryKey
    ? memberLoanHistory.loans
    : []
  const loans = staff ? fetchedLoans : [...fetchedLoans, ...extraMemberLoans]
  const payments = data?.[2]?.payments || []
  const readiness = data?.[3]?.readiness
  const eligibility = data?.[4]?.eligibility
  const availableLoanCapital = data?.[0]?.available_loan_capital || eligibility?.available_loan_capital || '0.00'
  const readinessAvailable = data?.[3]?.available !== false
  const readinessSubmissions = data?.[3]?.submissions || []
  const pendingLoanApplications = loans.filter((loan) => loan.status === 'pending')
  const pendingLoanCount = data?.[1]?.pending_count ?? pendingLoanApplications.length
  const activeStaffLoanTab = staffLoanTab || (
    readinessSubmissions.length ? 'documents' : pendingLoanCount ? 'applications' : 'offers'
  )
  const loanStatusCounts = Object.fromEntries(
    (data?.[1]?.status_counts || []).map((item) => [item.status, Number(item.total)])
  )
  loanStatusCounts.approved_active = (loanStatusCounts.approved || 0) + (loanStatusCounts.active || 0)
  const defaultStaffApplicationStatus = ['pending', 'approved_active', 'completed', 'rejected']
    .find((status) => loanStatusCounts[status] > 0) || 'pending'
  const staffApplicationStatuses = [
    { status: 'pending', label: 'Pending applications' },
    { status: 'approved_active', label: 'Approved / active' },
    { status: 'completed', label: 'Completed' },
    { status: 'rejected', label: 'Rejected' }
  ]
  const currentApplicationStatusLabel = staffApplicationStatuses
    .find((item) => item.status === staffApplicationStatus)?.label || 'Loans'
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

  async function refreshLoanData() {
    setActionError('')
    setRefreshing(true)
    try {
      await Promise.all(endpoints.map((endpoint) => refreshEndpoint(endpoint, { cache: 'no-store' })))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setRefreshing(false)
    }
  }

  async function loadMoreLoans() {
    if (staff || loadingMoreLoans || !(memberLoanHistory?.key === memberLoanHistoryKey
      ? memberLoanHistory.hasMore
      : data?.[1]?.pagination?.has_more)) return
    const nextPage = (memberLoanHistory?.key === memberLoanHistoryKey ? memberLoanHistory.page : 1) + 1
    setLoadingMoreLoans(true)
    setActionError('')
    try {
      const result = await apiRequest(`/loans?page=${nextPage}&per_page=2`, { token })
      const existingIds = new Set(loans.map((loan) => Number(loan.id)))
      const newLoans = (result.loans || []).filter((loan) => !existingIds.has(Number(loan.id)))
      setMemberLoanHistory((current) => ({
        key: memberLoanHistoryKey,
        page: nextPage,
        hasMore: Boolean(result.pagination?.has_more),
        loans: [
          ...(current?.key === memberLoanHistoryKey ? current.loans : []),
          ...newLoans,
        ],
      }))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setLoadingMoreLoans(false)
    }
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
    if (path === '/loans') {
      if (values.purpose === 'Other') {
        const detail = String(values.purpose_detail || '').trim()
        if (!/^[A-Za-z ]{1,128}$/.test(detail)) {
          setActionError('Use up to 128 letters and spaces only for the other loan purpose.')
          return
        }
        values.purpose = `Other: ${detail}`
      }
      delete values.purpose_detail
      const product = products.find((item) => Number(item.id) === Number(values.loan_type_id))
      const amount = Number(values.amount)
      const term = Number(values.term_months)
      const preview = product ? buildLoanSchedulePreview(amount, term, product.interest_rate) : null
      if (!product || !preview || !Number.isFinite(amount) || !Number.isInteger(term)) {
        setActionError('Check the loan amount and term, then try again.')
        return
      }
      setPendingLoanApplication({
        values,
        productName: product.name,
        amount,
        term,
        purpose: values.purpose,
        overdueRate: product.overdue_interest_rate,
        preview,
        totalRepayment: preview.reduce((total, row) => total + Number(row.total_due), 0)
      })
      setActionError('')
      return
    }
    setNotice('')
    setActionError('')
    try {
      await apiRequest(path, { token, method, body: JSON.stringify(values) })
      setNotice(successMessage)
      form.reset()
      if (path === '/loans') {
        setApplicationInputs((current) => {
          const next = { ...current }
          delete next[values.loan_type_id]
          return next
        })
      }
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function confirmLoanApplication() {
    if (!pendingLoanApplication || confirmingLoanApplication) return
    setConfirmingLoanApplication(true)
    setActionError('')
    try {
      const result = await apiRequest('/loans', {
        token,
        method: 'POST',
        body: JSON.stringify(pendingLoanApplication.values)
      })
      setNotice(result.message || 'Loan application submitted for staff review.')
      setPendingLoanApplication(null)
      setApplicationInputs((current) => {
        const next = { ...current }
        delete next[pendingLoanApplication.values.loan_type_id]
        return next
      })
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setConfirmingLoanApplication(false)
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

  async function recordLoanPayment(event, loan) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    if (!window.confirm(`Confirm that PHP ${values.amount} was received for ${loan.loan_code} and record this payment?`)) return
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest(`/loans/${loan.id}/payments`, {
        token,
        method: 'POST',
        body: JSON.stringify(values),
      })
      setNotice(`${result.message} Remaining balance: PHP ${result.remaining_balance}. Reference: ${result.reference_no}`)
      setRecordingLoanId(null)
      await refreshLoanData()
    } catch (requestError) {
      setActionError(requestError.message)
    }
  }

  async function emailLoanPaymentDetails(loanId) {
    setNotice('')
    setActionError('')
    setSendingLoanEmailId(loanId)
    try {
      const result = await apiRequest(`/loans/${loanId}/payment-details/email`, {
        token,
        method: 'POST',
      })
      setNotice(result.message)
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setSendingLoanEmailId(null)
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

  async function deleteProduct(product) {
    if (!window.confirm(`Delete the "${product.name}" loan offer? This cannot be undone. Offers with loan history cannot be deleted.`)) return
    setNotice('')
    setActionError('')
    setDeletingOfferId(product.id)
    try {
      const result = await apiRequest(`/loan-products/${product.id}`, { token, method: 'DELETE' })
      setNotice(result.message)
      await refreshLoanData()
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setDeletingOfferId(null)
    }
  }

  return (
    <section className="portal-section">{/* SECTION - shows portal-section. */}
      {!standalone && <div className="section-heading">
        <div>
          <h2>Loans</h2>
          <p className="muted">Review your document status and explore available loan offers.</p>
        </div>
        <button className="button button-outline" type="button" onClick={refreshLoanData} disabled={loading || refreshing} aria-busy={refreshing}>{/* BUTTON - refresh status. */}
          {loading || refreshing ? 'Checking…' : 'Refresh status'}
        </button>
      </div>}
      {standalone && <div className="standalone-actions"><button className="button button-outline" type="button" onClick={refreshLoanData} disabled={loading || refreshing} aria-busy={refreshing}>{loading || refreshing ? 'Checking…' : 'Refresh status'}</button></div>}
      <PortalMessage error>{error || actionError}</PortalMessage>
      {staff && <nav className="loan-subtabs" aria-label="Loan management sections">
        <button className={`loan-subtab${activeStaffLoanTab === 'offers' ? ' active' : ''}`} type="button" aria-current={activeStaffLoanTab === 'offers' ? 'page' : undefined} onClick={() => setStaffLoanTab('offers')}>{/* BUTTON - loan offers. */}Loan offers</button>
        <button className={`loan-subtab${activeStaffLoanTab === 'documents' ? ' active' : ''}`} type="button" aria-current={activeStaffLoanTab === 'documents' ? 'page' : undefined} onClick={() => setStaffLoanTab('documents')}>{/* BUTTON - document reviews. */}
          Document reviews
          {readinessSubmissions.length > 0 && <span className="loan-review-badge" aria-label={`${readinessSubmissions.length} pending document reviews`}>{readinessSubmissions.length}</span>}
        </button>
        <button className={`loan-subtab${activeStaffLoanTab === 'applications' ? ' active' : ''}`} type="button" aria-current={activeStaffLoanTab === 'applications' ? 'page' : undefined} onClick={() => {
          setStaffLoanTab('applications')
          setStaffApplicationStatus((current) => current === 'pending' && !pendingLoanCount
            ? defaultStaffApplicationStatus
            : current)
          setLoansPage(1)
        }}>{/* BUTTON - applications. */}
          Applications
          {pendingLoanCount > 0 && <span className="loan-review-badge" aria-label={`${pendingLoanCount} loan applications awaiting review`}>{pendingLoanCount}</span>}
        </button>
      </nav>}

      {loading && <PortalSkeleton kind="cards" rows={3} label="Loading loan information" />}

      {!loading && staff && activeStaffLoanTab === 'documents' && (
        <section>{/* SECTION - shows loan document review requests. */}
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
                  }}>{/* BUTTON - open image. */}Open image</button>
                </li>
              ))}</ul>
              <div className="button-row">
                <button className="button button-primary" type="button" onClick={() => reviewReadiness(submission.id, 'approve')}>{/* BUTTON - approve documents. */}Approve documents</button>
                <button className="button button-outline" type="button" onClick={() => reviewReadiness(submission.id, 'reject')}>{/* BUTTON - request corrections. */}Request corrections</button>
              </div>
            </article>
          ))}
        </section>
      )}
      {!loading && staff && activeStaffLoanTab === 'offers' && (
        <>
          <section className="offers-section">{/* SECTION - shows offers-section. */}
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
                    <div><dt>Overdue interest</dt><dd>{product.overdue_interest_rate}% per year</dd></div>
                    <div><dt>Maximum amount</dt><dd>PHP {product.max_amount}</dd></div>
                    <div><dt>Maximum term</dt><dd>{product.max_term_months} months</dd></div>
                  </dl>
                  <div className="button-row">
                    <button className="button button-outline" type="button" onClick={() => toggleProduct(product)}>{/* BUTTON - make available. */}
                      {product.status === 'active' ? 'Pause offer' : 'Make available'}
                    </button>
                    <button className="button button-outline loan-offer-delete" type="button" onClick={() => deleteProduct(product)} disabled={deletingOfferId === product.id}>{/* BUTTON - delete offer. */}
                      {deletingOfferId === product.id ? 'Deleting…' : 'Delete offer'}
                    </button>
                  </div>
                </article>
              ))}</div>}
          </section>
          <details className="portal-card">
            <summary>Create loan offer</summary>
            <form className="form-grid" onSubmit={(event) => submit(event, '/loan-products', 'POST', 'Loan offer created.')}>{/* FORM - saves a loan offer. */}
              <label>Product name<input name="name" required maxLength="100" /></label>
              <label>Monthly interest rate (%)<input name="interest_rate" type="number" min="0" max="99.99" step="0.01" required /></label>
              <label>Overdue interest (% per year)<input name="overdue_interest_rate" type="number" min="0" max="99.99" step="0.01" defaultValue="6.00" required /></label>
              <label>Maximum amount (PHP)<input name="max_amount" type="number" min="0.01" step="0.01" required /></label>
              <label>Maximum term (months)<input name="max_term_months" type="number" min="1" max="120" required /></label>
              <label className="full">Description<input name="description" maxLength="255" /></label>
              <button className="button button-primary" type="submit">{/* BUTTON - create active offer. */}Create active offer</button>
            </form>
          </details>
        </>
      )}
      {!loading && !staff && (
        <>
          <div className="member-loan-readiness">
            {eligibility && <details
              className="portal-card loan-eligibility-card"
              open={eligibilityDetailsOpen?.status === eligibility.eligible
                ? eligibilityDetailsOpen.open
                : !eligibility.eligible}
              onToggle={(event) => setEligibilityDetailsOpen({
                status: eligibility.eligible,
                open: event.currentTarget.open
              })}
            >
              <summary>
                <span>Loan eligibility check</span>
                <strong>{eligibility.eligible ? 'Eligible to apply' : 'Not yet eligible'}</strong>
              </summary>
              <div className="loan-eligibility-details">
                <p>{eligibility.eligible
                  ? `You may apply for up to ${formatPesos(eligibility.max_eligible_amount)}. Staff still review every application.`
                  : 'Meeting these requirements allows you to apply; it does not guarantee loan approval.'}</p>
                <dl className="offer-facts">
                  <div><dt>Paid-up share capital</dt><dd>{formatPesos(eligibility.paid_up_share_capital)} / {formatPesos(eligibility.criteria.minimum_paid_up_share_capital)} minimum</dd></div>
                  <div><dt>Membership waiting time</dt><dd>{formatSimulationTime(membershipElapsedSeconds)} / {formatSimulationTime(membershipRequiredSeconds)}</dd></div>
                  <div><dt>Savings balance</dt><dd>{formatPesos(eligibility.savings_balance)} / {formatPesos(eligibility.criteria.minimum_savings_balance)} minimum</dd></div>
                </dl>
                {eligibility.reasons?.length > 0 && <ul className="member-order">{eligibility.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
              </div>
            </details>}
            {!readinessAvailable ? <p className="notice">Loan document review and loan applications are available to members aged 20 and over.</p> : (
              <details
                className="portal-card loan-readiness-card"
                open={readinessDetailsOpen?.status === readiness?.status
                  ? readinessDetailsOpen.open
                  : readiness?.status !== 'approved'}
                onToggle={(event) => setReadinessDetailsOpen({
                  status: readiness?.status,
                  open: event.currentTarget.open
                })}
              >
                <summary>Loan document approval</summary>
                {readiness?.status === 'pending' && <p className="notice">Your loan documents are waiting for staff review. Loan offers will appear here after approval.</p>}
                {readiness?.status === 'approved' && <p className="notice">Your loan documents have been approved. You can now view the available loan offers below.</p>}
                {readiness?.status === 'rejected' && <p className="message message-error">Your loan documents need corrections. Staff note: {readiness.review_note || 'Please upload a corrected document set.'}</p>}
                {!error && readiness?.status !== 'pending' && readiness?.status !== 'approved' && (
                  <form className="form-grid" onSubmit={submitReadiness}>{/* FORM - submits loan documents for review. */}
                    <label className="full">Supporting document images
                      <input name="documents[]" type="file" accept="image/jpeg,image/png,image/webp" multiple required />
                      <small>Attach up to five images, 5 MB each and 7 MB combined. Follow the checklist given by your cooperative; requirements vary by product. Common examples may include a valid ID and proof of income or livelihood.</small>
                    </label>
                    <button className="button button-primary" type="submit">{/* BUTTON - submit documents for review. */}Submit documents for review</button>
                  </form>
                )}
                {readiness && data?.[3]?.documents?.length > 0 && (
                  <ul className="document-list">{data[3].documents.map((document) => (
                    <li key={document.id}>
                      <span>{document.original_name} · {Math.ceil(document.file_size / 1024)} KB</span>
                      <button className="text-button" type="button" onClick={async () => {
                        try { await openProtectedImage(token, `/loan-documents/${document.id}`) } catch (requestError) { setActionError(requestError.message) }
                      }}>{/* BUTTON - open image. */}Open image</button>
                    </li>
                  ))}</ul>
                )}
              </details>
            )}
          </div>
          {readiness?.status === 'approved' && (
            <section className="offers-section">{/* SECTION - shows offers-section. */}
              <div className="section-heading section-heading-compact">
                <div><h3>Available loan offers</h3><p className="muted">Choose an offer to see its application form.</p></div>
              </div>
              <article className="portal-card loan-capital-summary">
                <span>Cooperative lending capital available</span>
                <strong>{formatPesos(availableLoanCapital)}</strong>
                <small>Pending applications and unpaid principal reduce availability. Collected interest already allocated to investors is not counted as lendable capital.</small>
                {loanCapitalBreakdown && <details className="loan-capital-breakdown">
                  <summary>View lending-capital calculation</summary>
                  <dl>
                    <div><dt>Paid-up share capital</dt><dd>{formatPesos(loanCapitalBreakdown.paid_up_share_capital)}</dd></div>
                    <div><dt>Collected interest not allocated to investors</dt><dd>{formatPesos(loanCapitalBreakdown.lendable_interest)}</dd></div>
                    <div><dt>Outstanding loan principal</dt><dd>− {formatPesos(loanCapitalBreakdown.outstanding_principal)}</dd></div>
                    <div><dt>Pending loan applications</dt><dd>− {formatPesos(loanCapitalBreakdown.pending_principal)}</dd></div>
                    <div className="loan-capital-breakdown-total"><dt>Available to lend</dt><dd>{formatPesos(availableLoanCapital)}</dd></div>
                  </dl>
                  <small>Distributed interest: {formatPesos(loanCapitalBreakdown.distributed_interest)}. Overdue penalties remain separate from this regular-interest distribution.</small>
                </details>}
              </article>
              {products.length === 0
                ? <p className="notice">{productLoadFailed
                  ? 'Your documents are approved, but loan offers could not be loaded. Use Refresh status to try again or contact cooperative staff.'
                  : Number(availableLoanCapital) <= 0
                    ? 'No share capital is currently available to lend. New offers will appear when capital becomes available.'
                    : 'Your documents are approved, but there are no active offers within the available share capital. Please check back later or contact cooperative staff.'}</p>
                : <div className={`offer-grid${expandedOfferId ? ' has-expanded' : ''}`}>{products.map((product) => (
                  <article className={`offer-card${expandedOfferId === product.id ? ' expanded' : ''}`} key={product.id}>
                    <div className="offer-card-heading">
                      <div><h4>{product.name}</h4><p>{product.description || 'Cooperative loan offer'}</p></div>
                      <span className="status status-active">Available</span>
                    </div>
                    <dl className="offer-facts">
                      <div><dt>Monthly rate</dt><dd>{product.interest_rate}%</dd></div>
                      <div><dt>Overdue interest</dt><dd>{product.overdue_interest_rate}% per year</dd></div>
                      <div><dt>Product maximum</dt><dd>{formatPesos(product.max_amount)}</dd></div>
                      <div><dt>Your current limit</dt><dd>{formatPesos(Math.min(Number(product.max_amount), Number(eligibility?.max_eligible_amount || 0)))}</dd></div>
                      <div><dt>Maximum term</dt><dd>{product.max_term_months} months</dd></div>
                    </dl>
                    <details
                      className="offer-application"
                      open={expandedOfferId === product.id}
                      onToggle={(event) => {
                        if (event.currentTarget.open) setExpandedOfferId(product.id)
                        else if (expandedOfferId === product.id) setExpandedOfferId(null)
                      }}
                    >
                      <summary>Apply for this offer</summary>
                      {!eligibility?.eligible && <p className="notice">You cannot submit an application yet. Review the eligibility reasons above.</p>}
                      <form className="form-grid" onSubmit={(event) => submit(event, '/loans', 'POST', 'Loan application submitted.')}>{/* FORM - submits a loan application. */}
                        <input type="hidden" name="loan_type_id" value={product.id} />
                        <label>Amount (PHP)<input name="amount" type="number" min="0.01" max={Math.min(Number(product.max_amount), Number(eligibility?.max_eligible_amount || 0))} step="0.01" required disabled={!eligibility?.eligible} value={applicationInputs[product.id]?.amount ?? ''} onChange={(event) => {
                          const rawAmount = event.target.value
                          const maximumAmount = Math.min(Number(product.max_amount), Number(eligibility?.max_eligible_amount || 0))
                          const amount = rawAmount && Number.isFinite(Number(rawAmount)) && Number(rawAmount) > maximumAmount
                            ? maximumAmount.toFixed(2)
                            : rawAmount
                          setApplicationInputs((current) => ({ ...current, [product.id]: { ...current[product.id], amount } }))
                        }} /></label>
                        <label>Term (months)<input name="term_months" type="number" min="1" max={product.max_term_months} required value={applicationInputs[product.id]?.term ?? ''} onChange={(event) => {
                          const rawTerm = event.target.value
                          const maximumTerm = Number(product.max_term_months)
                          const term = rawTerm && Number.isFinite(Number(rawTerm)) && Number(rawTerm) > maximumTerm
                            ? String(maximumTerm)
                            : rawTerm
                          setApplicationInputs((current) => ({ ...current, [product.id]: { ...current[product.id], term } }))
                        }} /></label>
                        <label className="full">Purpose
                          <select name="purpose" value={applicationInputs[product.id]?.purpose || ''} required onChange={(event) => setApplicationInputs((current) => ({ ...current, [product.id]: { ...current[product.id], purpose: event.target.value } }))}>
                            <option value="" disabled>Select a loan purpose</option>
                            <option value="Medical">Medical</option>
                            <option value="Emergency">Emergency</option>
                            <option value="Allowance">Allowance</option>
                            <option value="Education">Education</option>
                            <option value="Livelihood / business">Livelihood / business</option>
                            <option value="Other">Other</option>
                          </select>
                        </label>
                        {applicationInputs[product.id]?.purpose === 'Other' && <label className="full">Specify other purpose<input name="purpose_detail" maxLength="128" pattern="[A-Za-z ]{1,128}" title="Use up to 128 letters and spaces only." required value={applicationInputs[product.id]?.purposeDetail || ''} onChange={(event) => {
                          const purposeDetail = event.target.value.replace(/[^A-Za-z ]/g, '').slice(0, 128)
                          setApplicationInputs((current) => ({ ...current, [product.id]: { ...current[product.id], purposeDetail } }))
                        }} /></label>}
                        {Number(product.overdue_interest_rate) > 0 && (
                          <div className="full overdue-interest-notice">
                            <div className="overdue-interest-notice-copy">
                              <span className="eyebrow">Overdue interest</span>
                              <p>{product.overdue_interest_rate}% per year applies to unpaid installment principal starting the day after its due date. It does not compound.</p>
                            </div>
                            <label className="overdue-interest-consent">
                              <input className="overdue-interest-checkbox" name="accept_overdue_terms" type="checkbox" value="1" required />
                              <span>
                                <strong>I understand these overdue-interest terms.</strong>
                                <small>A charge may apply if an installment is paid after its due date.</small>
                              </span>
                            </label>
                          </div>
                        )}
                        {applicationInputs[product.id]?.amount && !loanApplicationIsWithinLimits(product, eligibility, applicationInputs[product.id]) && (
                          <p className="full notice">Enter an amount up to {formatPesos(Math.min(Number(product.max_amount), Number(eligibility?.max_eligible_amount || 0)))} and a term from 1 to {product.max_term_months} months. The estimate and submission stay disabled until both are within the offer limits.</p>
                        )}
                        {loanApplicationIsWithinLimits(product, eligibility, applicationInputs[product.id]) && buildLoanSchedulePreview(applicationInputs[product.id]?.amount, applicationInputs[product.id]?.term, product.interest_rate) && (
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
                        <button className="button button-primary" type="submit" disabled={!eligibility?.eligible || !loanApplicationIsWithinLimits(product, eligibility, applicationInputs[product.id])}>{/* BUTTON - submit application for staff review. */}Submit application for staff review</button>
                      </form>
                    </details>
                  </article>
                ))}</div>}
            </section>
          )}
        </>
      )}

      {!loading && (!staff || activeStaffLoanTab === 'applications') && <>
      <h3>{staff ? 'Loan applications' : 'Your loans'}</h3>
      {staff && <nav className="loan-subtabs loan-status-subtabs" aria-label="Filter loan applications by status">
        {staffApplicationStatuses.map(({ status, label }) => (
          <button
            className={`loan-subtab${staffApplicationStatus === status ? ' active' : ''}`}
            type="button"
            key={status}
            aria-pressed={staffApplicationStatus === status}
            onClick={() => {
              setStaffApplicationStatus(status)
              setLoansPage(1)
            }}
          >{/* BUTTON - filters loan applications by status. */}
            {label}<span className="loan-status-count">{loanStatusCounts[status] || 0}</span>
          </button>
        ))}
      </nav>}
      {!staff && Number(eligibility?.active_loan_balance) > 0 && <section className="portal-card outstanding-loan-summary">
        <span className="eyebrow">Outstanding loan balance</span>
        <strong>{formatPesos(eligibility.active_loan_balance)}</strong>
        <div className="outstanding-loan-details">
          {(eligibility.active_loans || []).map((loan) => (
            <div key={loan.id}>
              <span>{loan.loan_type_name} · {loan.loan_code}</span>
              <span>Balance: {formatPesos(loan.current_balance)}</span>
              <span>Next due: {loan.next_due_date || 'No upcoming installment'}</span>
              {loan.next_due_date && <span>Installment due: {formatPesos(loan.next_due_amount)}</span>}
            </div>
          ))}
          {!(eligibility.active_loans || []).length && <span>Your active loan details are being refreshed.</span>}
        </div>
      </section>}
      {data && loans.length === 0 && <p className="muted">
        {staff ? `No ${currentApplicationStatusLabel.toLowerCase()} found.` : 'No loan applications yet.'}
      </p>}
      {loans.map((loan) => (
        <article className="portal-card" key={loan.id}>
          <div className="item-heading">
            <div><strong>{loan.loan_type_name}</strong><span>{loan.loan_code} · {loan.member_number || user.member?.member_number || 'Member'}</span></div>
            <span className={`status status-${loan.status}`}>{loan.status}</span>
          </div>
          <p>Requested PHP {loan.principal_amount} · {loan.term_months} months · {loan.interest_rate}% monthly</p>
          {Number(loan.overdue_interest_rate) > 0 && <p className="muted">Overdue interest: {loan.overdue_interest_rate}% per year, simple, on unpaid installment principal.</p>}
          {loan.status !== 'pending' && <p>Balance: PHP {loan.current_balance} · Paid: PHP {loan.total_paid}</p>}
          {loan.purpose && <p className="muted">Purpose: {loan.purpose}</p>}
          {loan.review_note && <p className="notice">Review note: {loan.review_note}</p>}
          <div className="button-row">
            {loan.status === 'approved' || loan.status === 'active'
              ? <button className="button button-outline" type="button" onClick={() => showSchedule(loan.id)}>View schedule</button>
              : null}
            {staff && ['approved', 'active'].includes(loan.status) && Number(loan.available_repayment_amount ?? loan.current_balance) > 0 && (
              <button className="button button-outline" type="button" onClick={() => {
                setRecordingLoanId(recordingLoanId === loan.id ? null : loan.id)
                setRecordPaymentAmount('')
              }}>{/* BUTTON - close payment form. */}
                {recordingLoanId === loan.id ? 'Close payment form' : 'Record payment'}
              </button>
            )}
            {staff && ['approved', 'active', 'completed'].includes(loan.status) && (
              <button
                className="button button-outline"
                type="button"
                onClick={() => emailLoanPaymentDetails(loan.id)}
                disabled={sendingLoanEmailId === loan.id}
                aria-busy={sendingLoanEmailId === loan.id}
              >{/* BUTTON - email payment details. */}
                {sendingLoanEmailId === loan.id ? 'Sending…' : 'Email payment details'}
              </button>
            )}
            {staff && loan.status === 'pending' && <>
              <button className="button button-primary" type="button" onClick={() => reviewLoan(loan.id, 'approve')}>{/* BUTTON - approve. */}Approve</button>
              <button className="button button-outline" type="button" onClick={() => reviewLoan(loan.id, 'reject')}>{/* BUTTON - reject. */}Reject</button>
            </>}
          </div>
          {staff && recordingLoanId === loan.id && (
            <form className="form-grid staff-loan-payment-form" onSubmit={(event) => recordLoanPayment(event, loan)}>{/* FORM - records a loan payment. */}
              <p className="full notice">Record only a payment already received by the cooperative. Amounts reserved by a pending online checkout are unavailable. Recordable now: {formatPesos(loan.available_repayment_amount ?? loan.current_balance)}.</p>
              <label>Amount received (PHP)<input
                name="amount"
                type="number"
                min="0.01"
                max={loan.available_repayment_amount ?? loan.current_balance}
                step="0.01"
                required
                value={recordPaymentAmount}
                onChange={(event) => {
                  const rawAmount = event.target.value
                  const maximumCents = Math.max(0, Math.round(Number(loan.available_repayment_amount ?? loan.current_balance) * 100))
                  const enteredCents = Math.round(Number(rawAmount) * 100)
                  setRecordPaymentAmount(
                    rawAmount && Number.isFinite(enteredCents) && enteredCents > maximumCents
                      ? (maximumCents / 100).toFixed(2)
                      : rawAmount
                  )
                }}
              /></label>
              <button className="button button-outline" type="button" onClick={() => {
                setRecordPaymentAmount(Number(loan.available_repayment_amount ?? loan.current_balance).toFixed(2))
              }}>{/* BUTTON - full balance. */}Full balance</button>
              <label>Received via<select name="payment_method" defaultValue="cash" required>
                <option value="cash">Cash</option>
                <option value="bank">Bank transfer</option>
                <option value="gcash">GCash</option>
                <option value="check">Check</option>
              </select></label>
              <button className="button button-primary" type="submit">{/* BUTTON - confirm received payment. */}Confirm received payment</button>
            </form>
          )}
        </article>
      ))}
      {staff && data?.[1]?.pagination && <div className="pagination-controls" aria-label="Loan history pages">
        <button className="button button-outline" type="button" disabled={loansPage <= 1 || loading} onClick={() => setLoansPage((page) => page - 1)}>{/* BUTTON - previous. */}Previous</button>
        <span>Page {loansPage}</span>
        <button className="button button-outline" type="button" disabled={!data[1].pagination.has_more || loading} onClick={() => setLoansPage((page) => page + 1)}>{/* BUTTON - next. */}Next</button>
      </div>}
      {!staff && (memberLoanHistory?.key === memberLoanHistoryKey
        ? memberLoanHistory.hasMore
        : Boolean(data?.[1]?.pagination?.has_more)) && <div className="load-more-row">
        <button className="button button-outline" type="button" onClick={loadMoreLoans} disabled={loadingMoreLoans || loading}>{/* BUTTON - load more loans. */}
          {loadingMoreLoans ? 'Loading…' : 'Load more loans'}
        </button>
      </div>}
      {staff && <details className="portal-card"><summary>Recent payments</summary>
        {payments.length ? <div className="table-wrap"><table><thead><tr><th>Loan</th><th>Member</th><th>Total</th><th>Principal</th><th>Interest</th><th>Overdue interest</th><th>Method</th><th>Date</th></tr></thead>
          <tbody>{payments.map((payment) => <tr key={payment.id}><td>{payment.loan_code}</td><td>{payment.first_name} {payment.last_name}</td><td>{formatPesos(payment.amount_paid)}</td><td>{payment.breakdown_recorded ? formatPesos(payment.principal_paid) : 'Legacy — not split'}</td><td>{payment.breakdown_recorded ? formatPesos(payment.interest_paid) : 'Legacy — not split'}</td><td>{payment.breakdown_recorded ? formatPesos(payment.overdue_interest_paid) : '—'}</td><td>{payment.payment_method}</td><td>{payment.payment_date}</td></tr>)}</tbody>
        </table></div> : <p className="muted">No payments recorded.</p>}
        {data?.[2]?.pagination && <div className="pagination-controls" aria-label="Loan payment pages">
          <button className="button button-outline" type="button" disabled={paymentsPage <= 1 || loading} onClick={() => setPaymentsPage((page) => page - 1)}>{/* BUTTON - previous. */}Previous</button>
          <span>Page {paymentsPage}</span>
          <button className="button button-outline" type="button" disabled={!data[2].pagination.has_more || loading} onClick={() => setPaymentsPage((page) => page + 1)}>{/* BUTTON - next. */}Next</button>
        </div>}
      </details>}
      </>}
      {schedule && (
        <div className="record-modal-backdrop">
          <section className="record-modal loan-schedule-modal" role="dialog" aria-modal="true" aria-labelledby="loan-schedule-title">{/* SECTION - shows record-modal. */}
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
                <div><span>Overdue rate</span><strong>{schedule.loan.overdue_interest_rate}% yearly</strong></div>
                <div><span>Term / total interest</span><strong>{schedule.loan.term_months} months · {formatPesos(schedule.total_interest)}</strong></div>
              </div>
              <p className="loan-schedule-explanation">Interest uses the cooperative’s current flat-interest rule: approved principal × monthly rate × term. Installments are equal, with any rounding cents distributed across early installments. Remaining shows unpaid installments after each row.</p>
              <div className="table-wrap"><table className="loan-schedule-table"><thead><tr><th>#</th><th>Due date</th><th>Principal</th><th>Interest</th><th>Overdue interest</th><th>Total due</th><th>Paid</th><th>Remaining after</th><th>Status</th></tr></thead>
                <tbody>{schedule.schedule.map((item, index) => <tr key={item.id}><td>{index + 1}</td><td>{item.due_date}</td><td>{formatPesos(item.principal_due)}</td><td>{formatPesos(item.interest_due)}</td><td>{formatPesos(item.overdue_interest_accrued)}</td><td>{formatPesos(item.display_total_due)}</td><td>{formatPesos(item.display_paid_amount)}</td><td>{formatPesos(item.remaining_after)}</td><td>{item.status}</td></tr>)}</tbody>
                <tfoot><tr><th colSpan="2">Totals</th><th>{formatPesos(schedule.total_principal)}</th><th>{formatPesos(schedule.total_interest)}</th><th>{formatPesos(schedule.total_due)}</th><th>{formatPesos(schedule.total_paid)}</th><th>{formatPesos(schedule.loan.current_balance)}</th><th /></tr></tfoot>
              </table></div>
              <footer className="ledger-document-footer"><span>Generated {schedule.generated_at}</span><span>Actual payments and account balances may change this schedule. Contact cooperative staff for clarification.</span></footer>
            </article>
          </section>
        </div>
      )}
      {pendingLoanApplication && <div className="record-modal-backdrop">
        <section className="record-modal loan-application-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="loan-application-confirm-title">{/* SECTION - shows record-modal. */}
          <div className="record-modal-heading">
            <div><span className="eyebrow">Review before submission</span><h2 id="loan-application-confirm-title">Confirm your loan application</h2></div>
          </div>
          <PortalMessage error>{actionError}</PortalMessage>
          <p>Check that the requested amount and repayment term are correct. Go back to edit them if needed.</p>
          <dl className="offer-facts loan-application-confirm-facts">
            <div><dt>Loan offer</dt><dd>{pendingLoanApplication.productName}</dd></div>
            <div><dt>Amount requested</dt><dd>{formatPesos(pendingLoanApplication.amount)}</dd></div>
            <div><dt>Repayment term</dt><dd>{pendingLoanApplication.term} months</dd></div>
            <div><dt>Purpose</dt><dd>{pendingLoanApplication.purpose}</dd></div>
            <div><dt>Estimated total repayment</dt><dd>{formatPesos(pendingLoanApplication.totalRepayment)}</dd></div>
            {Number(pendingLoanApplication.overdueRate) > 0 && <div><dt>Overdue interest if late</dt><dd>{pendingLoanApplication.overdueRate}% yearly, simple</dd></div>}
          </dl>
          <p className="muted">The estimate is not an approval. Cooperative staff will review your application and confirm the final schedule.</p>
          <div className="button-row">
            <button className="button button-outline" type="button" disabled={confirmingLoanApplication} onClick={() => setPendingLoanApplication(null)}>{/* BUTTON - go back and edit. */}Go back and edit</button>
            <button className="button button-primary" type="button" disabled={confirmingLoanApplication} onClick={confirmLoanApplication}>{/* BUTTON - confirm and submit application. */}
              {confirmingLoanApplication ? 'Submitting…' : 'Confirm and submit application'}
            </button>
          </div>
        </section>
      </div>}
    </section>
  )
}

// This block shows daily cooperative contribution cycles and payouts.
function CooperativePortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [contributionPage, setContributionPage] = useState(1)
  const [payoutPage, setPayoutPage] = useState(1)
  const endpoints = useMemo(() => [
    `/cooperative/cycles?contribution_page=${contributionPage}&payout_page=${payoutPage}&per_page=50`
  ], [contributionPage, payoutPage])
  const { data, error, loading } = usePortalData(token, refreshKey, endpoints)
  const setNotice = dispatchActionToast
  const [actionError, setActionError] = useState('')
  const [draftCycleId, setDraftCycleId] = useState('')
  const [cyclePreview, setCyclePreview] = useState(null)
  const [creatingCycle, setCreatingCycle] = useState(false)
  const createCycleForm = useRef(null)
  const cyclesData = data?.[0]
  const cycles = cyclesData?.cycles || []
  const members = cyclesData?.members || []

  // This block checks the details before creating a cooperative cycle.
  function reviewNewCycle(event) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    const member_ids = Array.from(form.elements.member_ids.selectedOptions, (option) => option.value)
    if (member_ids.length < 2) {
      setActionError('Select at least two active members before reviewing the cycle.')
      return
    }
    const selectedMembers = members.filter((member) => member_ids.includes(String(member.id)))
    setNotice('')
    setActionError('')
    setCyclePreview({
      name: values.name.trim(),
      daily_contribution: values.daily_contribution,
      start_date: values.start_date,
      member_ids,
      members: selectedMembers,
    })
  }

  async function confirmNewCycle() {
    if (!cyclePreview || creatingCycle) return
    setNotice('')
    setActionError('')
    setCreatingCycle(true)
    try {
      const result = await apiRequest('/cooperative/cycles', {
        token,
        method: 'POST',
        body: JSON.stringify({
          name: cyclePreview.name,
          daily_contribution: cyclePreview.daily_contribution,
          start_date: cyclePreview.start_date,
          member_ids: cyclePreview.member_ids,
        }),
      })
      setNotice(result.message)
      setCyclePreview(null)
      createCycleForm.current?.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setCreatingCycle(false)
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

  async function removeCycle(cycle) {
    if (!window.confirm(`Remove the draft cycle "${cycle.name}"? Only drafts without contribution, payout, or payment history can be removed.`)) return
    await changeCycle('/cooperative/cycles', { cycle_id: cycle.id }, 'Draft cycle removed.', 'DELETE')
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
    <section className="portal-section">{/* SECTION - shows portal-section. */}
      {!standalone && <>
        <h2>Daily rotating savings (Paluwagan)</h2>
        <p className="muted">Members pay their daily contribution through Xendit. Once everyone has paid, the next person in the randomized order is ready for the pooled payout. Staff confirm the simulated payout, which is then added to that member’s available balance.</p>
      </>}
      <PortalMessage error>{error || actionError}</PortalMessage>
      {staff && <>
        <section className="cycle-create-card">{/* SECTION - shows cycle-create-card. */}
          <div>
            <span className="eyebrow">Staff action</span>
            <h3>Create a daily cycle</h3>
          </div>
          <form ref={createCycleForm} className="form-grid" onSubmit={reviewNewCycle}>{/* FORM - checks the cooperative cycle details before creation. */}
            <label>Cycle name<input name="name" required maxLength="120" /></label>
            <label>Daily contribution (PHP)<input name="daily_contribution" type="number" min="0.01" step="0.01" required /></label>
            <label>Start date<input name="start_date" type="date" min={TODAY} defaultValue={TODAY} required /></label>
            <label className="full">Members<select name="member_ids" multiple required size={Math.min(Math.max(members.length, 3), 8)}>
              {members.map((member) => <option key={member.id} value={member.id}>{member.member_number} · {member.first_name} {member.last_name}</option>)}
            </select><small>Select at least two active members. Hold Ctrl (Windows) or Command (Mac) to choose more than one.</small></label>
            <button className="button button-primary cycle-create-button" type="submit">{/* BUTTON - review cycle details. */}Review cycle details</button>
          </form>
        </section>
        {cycles.some((cycle) => cycle.status === 'draft') && (
          <details className="portal-card">
            <summary>Add members to an existing draft</summary>
            <form className="form-grid" onSubmit={enrollMembers}>{/* FORM - adds selected members to the cycle. */}
              <label>Draft cycle<select name="cycle_id" required value={draftCycleId} onChange={(event) => setDraftCycleId(event.target.value)}>
                <option value="">Select a cycle</option>
                {cycles.filter((cycle) => cycle.status === 'draft').map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}
              </select></label>
              <label className="full">Members<select name="member_ids" multiple required size={Math.min(Math.max(members.length, 3), 8)}>
                {members.filter((member) => !cycles.find((cycle) => String(cycle.id) === draftCycleId)?.members.some((enrolled) => Number(enrolled.member_id) === Number(member.id))).map((member) => <option key={member.id} value={member.id}>{member.member_number} · {member.first_name} {member.last_name}</option>)}
              </select><small>The server assigns a randomized payout order.</small></label>
              <button className="button button-outline" type="submit">{/* BUTTON - add selected members. */}Add selected members</button>
            </form>
          </details>
        )}
      </>}

      {loading && cycles.length === 0 && <PortalSkeleton kind="cards" rows={3} label="Loading daily cycles" />}
      {!loading && data && cycles.length === 0 && <p className="muted">No daily cycles are available.</p>}
      {cycles.map((cycle) => (
        <article className="portal-card" key={cycle.id}>
          <div className="item-heading">
            <div><strong>{cycle.name}</strong><span>PHP {cycle.daily_contribution} daily · Starts {cycle.start_date}</span></div>
            <span className={`status status-${cycle.status}`}>{cycle.status}</span>
          </div>
          <p>{cycle.today_contributions} of {cycle.member_count} contributions recorded today.</p>
          {staff && cycle.status === 'draft' && <div className="button-row">
            <button className="button button-primary" type="button" onClick={() => changeCycle('/cooperative/cycles/activate', { cycle_id: cycle.id }, 'Cycle activated.')}>{/* BUTTON - activate cycle. */}Activate cycle</button>
            <button
              className="button button-outline"
              type="button"
              disabled={cycle.can_remove === false}
              title={cycle.can_remove === false ? 'This draft has transaction history and cannot be removed.' : undefined}
              onClick={() => removeCycle(cycle)}
            >{/* BUTTON - remove draft. */}Remove draft</button>
          </div>}
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
          <button className="button button-outline" type="button" disabled={contributionPage <= 1 || loading} onClick={() => setContributionPage((page) => page - 1)}>{/* BUTTON - previous. */}Previous</button>
          <span>Page {contributionPage}</span>
          <button className="button button-outline" type="button" disabled={!cyclesData.contributions_pagination.has_more || loading} onClick={() => setContributionPage((page) => page + 1)}>{/* BUTTON - next. */}Next</button>
        </div>}
        <h3>Payout history</h3>
        {cyclesData.payouts.length ? <div className="table-wrap"><table><thead><tr><th>Cycle</th><th>Recipient</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>{cyclesData.payouts.map((item) => <tr key={item.id}><td>{item.cycle_name}</td><td>{item.first_name} {item.last_name}</td><td>{item.payout_date}</td><td>PHP {item.amount}</td><td>{item.status}</td></tr>)}</tbody>
        </table></div> : <p className="muted">No payouts are recorded.</p>}
        {cyclesData.payouts_pagination && <div className="pagination-controls" aria-label="Paluwagan payout pages">
          <button className="button button-outline" type="button" disabled={payoutPage <= 1 || loading} onClick={() => setPayoutPage((page) => page - 1)}>{/* BUTTON - previous. */}Previous</button>
          <span>Page {payoutPage}</span>
          <button className="button button-outline" type="button" disabled={!cyclesData.payouts_pagination.has_more || loading} onClick={() => setPayoutPage((page) => page + 1)}>{/* BUTTON - next. */}Next</button>
        </div>}
      </>}
      {cyclePreview && <div className="record-modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creatingCycle) setCyclePreview(null)
      }}>
        <section className="record-modal cycle-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="cycle-confirm-title">{/* SECTION - shows record-modal. */}
          <div className="record-modal-heading">
            <div><span className="eyebrow">Review before creating</span><h2 id="cycle-confirm-title">Confirm daily cycle</h2></div>
            <button className="modal-close" type="button" onClick={() => setCyclePreview(null)} disabled={creatingCycle} aria-label="Close cycle confirmation">{/* BUTTON - close cycle confirmation. */}×</button>
          </div>
          <PortalMessage error>{actionError}</PortalMessage>
          <dl className="offer-facts">
            <div><dt>Cycle name</dt><dd>{cyclePreview.name}</dd></div>
            <div><dt>Daily contribution</dt><dd>{formatPesos(cyclePreview.daily_contribution)}</dd></div>
            <div><dt>Start date</dt><dd>{cyclePreview.start_date}</dd></div>
            <div><dt>Members selected</dt><dd>{cyclePreview.members.length}</dd></div>
          </dl>
          <h3>Selected members</h3>
          <div className="table-wrap cycle-review-members"><table>
            <thead><tr><th>Member number</th><th>Name</th></tr></thead>
            <tbody>{cyclePreview.members.map((member) => <tr key={member.id}>
              <td>{member.member_number}</td>
              <td>{member.first_name} {member.last_name}</td>
            </tr>)}</tbody>
          </table></div>
          <p className="muted">Confirm that the cycle details and member list are correct. CoopWise will create a draft and randomize payout order; you can review it before activating.</p>
          <div className="button-row">
            <button className="button button-outline" type="button" onClick={() => setCyclePreview(null)} disabled={creatingCycle}>{/* BUTTON - go back. */}Go back</button>
            <button className="button button-primary" type="button" onClick={confirmNewCycle} disabled={creatingCycle}>{/* BUTTON - confirm and create cycle. */}
              {creatingCycle ? 'Creating…' : 'Confirm and create cycle'}
            </button>
          </div>
        </section>
      </div>}
    </section>
  )
}

// This block shows member records and staff member actions.
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
    <section className="portal-section">{/* SECTION - shows portal-section. */}
      <div className="section-heading members-heading">
        {!standalone && <h2>Members</h2>}
        <span className="status" aria-live="polite">{members.length} shown</span>
      </div>
      <div className="member-search-layout">
        <label className="member-search-field">Search members
        <input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedMember(null) }} placeholder="Type a name, member number, or email" />
        </label>
        <small className="member-search-help">Results update as you type. Names may match anywhere; member numbers, phones, and emails match from the beginning.</small>
      </div>
      <PortalMessage error>{error}</PortalMessage>
      {loading && <PortalSkeleton rows={5} columns={7} label="Loading member directory" />}
      {!loading && !error && members.length === 0 && <StaffEmptyState type="members" title="No matching members" description="Try another name, member number, phone, or email address." />}
      {!loading && !!members.length && <div className="table-wrap"><table>
        <thead><tr><th>Member #</th><th>Name</th><th>Phone</th><th>Email</th><th>Account</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{members.map((member) => <tr key={member.id}>
          <td>{member.member_number}</td>
          <td>{member.first_name} {member.middle_name ? `${member.middle_name} ` : ''}{member.last_name}</td>
          <td>{member.contact_number || '—'}</td>
          <td>{member.email || '—'}</td>
          <td>{member.account_role}</td>
          <td><span className={`status status-${member.status}`}>{member.status}</span></td>
          <td><div className="member-row-actions">
            <button className="text-button" type="button" onClick={() => setLedgerMember(member)}>{/* BUTTON - savings ledger. */}Savings ledger</button>
            <button className="text-button" type="button" onClick={() => setCardMemberId(member.id)}>{/* BUTTON - id card. */}ID card</button>
            <button className="text-button" type="button" onClick={() => setSelectedMember(selectedMember === member.id ? null : member.id)}>{/* BUTTON - details. */}
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

// This block shows savings balances, payments, and the ledger.
function SavingsPortal({ token, user, refreshKey, standalone = false, onDeposit }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [loadedTransactionHistory, setLoadedTransactionHistory] = useState(null)
  const [loadingMoreTransactions, setLoadingMoreTransactions] = useState(false)
  const [appliedTransactionFilters, setAppliedTransactionFilters] = useState({ q: '', type: 'all', from: '', to: '' })
  const endpoints = useMemo(() => {
    const params = new URLSearchParams({ page: '1', per_page: '5' })
    if (staff && appliedTransactionFilters.q.trim()) params.set('q', appliedTransactionFilters.q.trim())
    if (staff && appliedTransactionFilters.type !== 'all') params.set('type', appliedTransactionFilters.type)
    if (staff && appliedTransactionFilters.from) params.set('from', appliedTransactionFilters.from)
    if (staff && appliedTransactionFilters.to) params.set('to', appliedTransactionFilters.to)
    return [`/savings?${params}`]
  }, [staff, appliedTransactionFilters])
  const { data, error, loading } = usePortalData(token, refreshKey, endpoints)
  const setNotice = dispatchActionToast
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
  const transactionHistoryKey = `${refreshKey}:${endpoints[0]}`
  const additionalTransactions = loadedTransactionHistory?.key === transactionHistoryKey
    ? loadedTransactionHistory.transactions
    : []
  const transactionPage = loadedTransactionHistory?.key === transactionHistoryKey
    ? loadedTransactionHistory.page
    : 1
  const hasMoreTransactions = loadedTransactionHistory?.key === transactionHistoryKey
    ? loadedTransactionHistory.hasMore
    : Boolean(data?.[0]?.pagination?.has_more)
  const allTransactions = [...transactions, ...additionalTransactions]
  const balance = data?.[0]?.balance
  const memberBalances = data?.[0]?.member_balances || []
  const savingsSummary = data?.[0]?.summary
  const autoPaySettings = autoPayDraft || data?.[0]?.auto_pay_preferences || { loan: false, paluwagan: false }
  const filteredMembers = memberBalances.filter((member) =>
    `${member.member_number} ${member.first_name} ${member.last_name}`.toLowerCase().includes(memberSearch.trim().toLowerCase())
  )
  const filteredTransactions = allTransactions.filter((entry) => {
    const matchesText = `${entry.member_number || ''} ${entry.first_name || ''} ${entry.last_name || ''} ${entry.reference_no} ${entry.description || ''}`.toLowerCase()
      .includes(transactionFilters.q.trim().toLowerCase())
    const date = String(entry.created_at || '').slice(0, 10)
    return matchesText
      && (transactionFilters.type === 'all' || entry.type === transactionFilters.type)
      && (!transactionFilters.from || date >= transactionFilters.from)
      && (!transactionFilters.to || date <= transactionFilters.to)
  })

  async function loadMoreTransactions() {
    if (loadingMoreTransactions || !hasMoreTransactions) return
    const nextPage = transactionPage + 1
    const params = new URLSearchParams({ page: String(nextPage), per_page: '5' })
    if (staff && appliedTransactionFilters.q.trim()) params.set('q', appliedTransactionFilters.q.trim())
    if (staff && appliedTransactionFilters.type !== 'all') params.set('type', appliedTransactionFilters.type)
    if (staff && appliedTransactionFilters.from) params.set('from', appliedTransactionFilters.from)
    if (staff && appliedTransactionFilters.to) params.set('to', appliedTransactionFilters.to)
    setLoadingMoreTransactions(true)
    setActionError('')
    try {
      const result = await apiRequest(`/savings?${params}`, { token })
      const existingIds = new Set(allTransactions.map((transaction) => Number(transaction.id)))
      const newTransactions = (result.transactions || [])
        .filter((transaction) => !existingIds.has(Number(transaction.id)))
      setLoadedTransactionHistory((current) => ({
        key: transactionHistoryKey,
        page: nextPage,
        hasMore: Boolean(result.pagination?.has_more),
        transactions: [
          ...(current?.key === transactionHistoryKey ? current.transactions : []),
          ...newTransactions,
        ],
      }))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setLoadingMoreTransactions(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
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
      <button className="text-button withdrawal-back-link" type="button" onClick={() => { setWithdrawalMode(false); setActionError('') }}>{/* BUTTON - ← back to savings. */}← Back to Savings</button>
      <div className="withdrawal-page-heading">
        <span className="withdrawal-page-icon"><StaffIcon name="savings" /></span>
        <div><span className="eyebrow">Savings</span><h2>Withdraw</h2><p>Choose an amount and destination. This records a withdrawal in CoopWise; it does not send money externally.</p></div>
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
          <button className="button button-primary withdrawal-next" type="button" disabled={!Number(withdrawalAmount) || Number(withdrawalAmount) <= 0 || Math.round(Number(withdrawalAmount) * 100) > (balance || 0)} onClick={() => { setActionError(''); setWithdrawalStep(2) }}>{/* BUTTON - choose destination. */}Choose destination</button>
        </>}
        {withdrawalStep === 2 && <>
          <span className="eyebrow">Step 2 of 3</span><h3>Where should the withdrawal go?</h3>
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
            <div><dt>Balance after withdrawal</dt><dd>{formatPesos(Math.max(0, ((balance || 0) - Math.round(Number(withdrawalAmount) * 100)) / 100))}</dd></div>
          </dl>
          <p className="withdrawal-demo-note">This updates your CoopWise savings ledger. No external bank or e-wallet transfer is made.</p>
          <div className="button-row"><button className="button button-outline" type="button" disabled={withdrawalSubmitting} onClick={() => { setWithdrawalStep(2); setWithdrawalRequestKey(null) }}>Change destination</button><button className="button button-primary" type="button" disabled={withdrawalSubmitting} onClick={submitWithdrawal}>{withdrawalSubmitting ? 'Processing…' : `Confirm withdraw to ${selectedDestination?.name}`}</button></div>
        </>}
      </div>
    </section>
  }

  return (
    <section className="portal-section">{/* SECTION - shows portal-section. */}
      {!standalone && <h2>Savings</h2>}
      {!staff && <div className="savings-member-overview">
        <div className="portal-card savings-balance"><span>Available savings</span><strong>{loading && !data ? 'Loading…' : formatPesos((balance || 0) / 100)}</strong></div>
        <div className="savings-member-actions">
          <button className="button button-outline" type="button" disabled={loading || !(balance > 0)} onClick={() => { setWithdrawalMode(true); setWithdrawalStep(1); setActionError('') }}>{/* BUTTON - withdraw. */}Withdraw</button>
          <button className="button button-primary" type="button" onClick={onDeposit}>{/* BUTTON - deposit to savings. */}Deposit to savings</button>
        </div>
        <button className="button button-primary" type="button" onClick={() => { setSelectedSavingsMember(null); setLedgerOpen(true) }}>{/* BUTTON - view / print my savings ledger. */}View / print my savings ledger</button>
      </div>}
      {!staff && data?.[0]?.balance_breakdown && <div className="report-grid savings-balance-breakdown">
        <article className="portal-card"><span>Loan proceeds credited</span><strong>{formatPesos(data[0].balance_breakdown.loan_credits)}</strong></article>
        <article className="portal-card"><span>Paluwagan payouts credited</span><strong>{formatPesos(data[0].balance_breakdown.paluwagan_credits)}</strong></article>
        <article className="portal-card"><span>Other historical credits</span><strong>{formatPesos(data[0].balance_breakdown.other_credits)}</strong></article>
        <article className="portal-card"><span>Total withdrawals recorded</span><strong>{formatPesos(data[0].balance_breakdown.withdrawals)}</strong></article>
      </div>}
      {!staff && data && (
        <form className="portal-card autopay-card" onSubmit={saveAutoPay}>{/* FORM - saves the savings auto-payment settings. */}
          <div className="autopay-heading"><div><span className="eyebrow">Optional convenience</span><h3>Automatic payments from savings</h3></div><button className="button button-primary" type="submit" disabled={autoPaySaving}>{autoPaySaving ? 'Saving…' : 'Save choices'}</button></div>
          <p>These choices are off until you opt in. When enabled, the daily payment job pays due amounts only when funds are available and records each savings withdrawal and matching payment. You can turn either option off at any time.</p>
          <label className="autopay-option"><input type="checkbox" checked={autoPaySettings.loan} onChange={(event) => setAutoPayDraft({ ...autoPaySettings, loan: event.target.checked })} /><span><strong>Loan installments</strong><small>Pay due loan installments from savings. If funds are short, an available partial amount may be applied to the earliest due installment.</small></span></label>
          <label className="autopay-option"><input type="checkbox" checked={autoPaySettings.paluwagan} onChange={(event) => setAutoPayDraft({ ...autoPaySettings, paluwagan: event.target.checked })} /><span><strong>Daily Paluwagan contributions</strong><small>Pay the active cycle’s daily contribution from savings when the cycle is due and the funds are available.</small></span></label>
          <p className="autopay-caveat">Auto-pay runs only after the cooperative configures the recurring daily job. Savings withdrawals and their loan or Paluwagan records are saved together.</p>
        </form>
      )}
      {staff && savingsSummary && <section className="savings-admin-overview">
        <h3>Member balance overview</h3>
        <div className="report-grid">
          <article className="portal-card"><span>Members with ledger</span><strong>{savingsSummary.member_count}</strong></article>
          <article className="portal-card"><span>Total available balance</span><strong>{formatPesos(savingsSummary.balance)}</strong></article>
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
      {staff && <div className="savings-transaction-tools">
        <h3>Transaction review</h3>
        <div className="savings-filter-row">
          <label>Search<input value={transactionFilters.q} onChange={(event) => setTransactionFilters({ ...transactionFilters, q: event.target.value })} placeholder="Member, reference, description" /></label>
          <label>Type<select value={transactionFilters.type} onChange={(event) => setTransactionFilters({ ...transactionFilters, type: event.target.value })}><option value="all">All activity</option><option value="deposit">Credits</option><option value="withdrawal">Withdrawals</option></select></label>
          <label>From<input type="date" value={transactionFilters.from} onChange={(event) => setTransactionFilters({ ...transactionFilters, from: event.target.value })} /></label>
          <label>To<input type="date" value={transactionFilters.to} onChange={(event) => setTransactionFilters({ ...transactionFilters, to: event.target.value })} /></label>
          <button className="button button-outline" type="button" onClick={exportSavingsTransactions} disabled={!filteredTransactions.length || exportingTransactions}>{/* BUTTON - export filtered csv. */}{exportingTransactions ? 'Preparing export…' : 'Export filtered CSV'}</button>
        </div>
      </div>}
      <div className="staff-subsection-title"><StaffIcon name="savings" /><h3>Transaction history</h3></div>
      {loading && transactions.length === 0 && <PortalSkeleton rows={5} columns={staff ? 7 : 6} label="Loading savings transactions" />}
      {data && transactions.length === 0 && <p className="muted">No savings transactions recorded.</p>}
      {staff && transactions.length > 0 && filteredTransactions.length === 0 && <p className="muted">No transactions match these filters.</p>}
      {!!filteredTransactions.length && <div className="table-wrap"><table><thead><tr>
        <th>Date</th>{staff && <th>Member</th>}<th>Type</th><th>Amount</th><th>Balance after</th><th>Reference</th><th>Description</th>
      </tr></thead><tbody>{filteredTransactions.map((entry) => <tr key={entry.id}>
        <td>{entry.created_at}</td>{staff && <td>{entry.member_number} · {entry.first_name} {entry.last_name}</td>}
        <td>{entry.type}</td><td>PHP {entry.amount}</td><td>PHP {entry.balance_after}</td><td>{entry.reference_no}</td><td>{entry.description || '—'}</td>
      </tr>)}</tbody></table></div>}
      {hasMoreTransactions && <div className="load-more-row">
        <button className="button button-outline" type="button" disabled={loadingMoreTransactions || loading} onClick={loadMoreTransactions}>{/* BUTTON - load more. */}
          {loadingMoreTransactions ? 'Loading…' : 'Load more'}
        </button>
      </div>}
      {ledgerOpen && <SavingsLedgerDialog token={token} member={selectedSavingsMember} onClose={() => { setLedgerOpen(false); setSelectedSavingsMember(null) }} />}
    </section>
  )
}

// This page shows share subscriptions, paid-up capital, and member-interest returns.
function ShareCapitalPortal({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [transactionsPage, setTransactionsPage] = useState(1)
  const [memberTransactionHistory, setMemberTransactionHistory] = useState(null)
  const [loadingMoreTransactions, setLoadingMoreTransactions] = useState(false)
  const endpoints = useMemo(() => [
    `${SHARE_CAPITAL_ENDPOINTS[0]}?page=${staff ? transactionsPage : 1}&per_page=${staff ? 50 : 5}`,
    SHARE_CAPITAL_ENDPOINTS[1],
    ...(!staff ? ['/savings?page=1&per_page=1'] : []),
  ], [staff, transactionsPage])
  const { data, error, loading } = usePortalData(token, refreshKey, endpoints)
  const setNotice = dispatchActionToast
  const [actionError, setActionError] = useState('')
  const [returnAction, setReturnAction] = useState('')
  const [loanInterestAction, setLoanInterestAction] = useState('')
  const [adminInvestmentSubmitting, setAdminInvestmentSubmitting] = useState(false)
  const [memberContributionSubmitting, setMemberContributionSubmitting] = useState(false)
  const [cancellingSubscriptionId, setCancellingSubscriptionId] = useState(null)
  const [transferringSubscriptionId, setTransferringSubscriptionId] = useState(null)
  const capital = data?.[0]
  const savingsBalance = data?.[2]?.balance
  const subscriptions = capital?.subscriptions || []
  const ownSubscriptions = staff
    ? subscriptions.filter((item) => Number(item.owner_user_id) === Number(user.id))
    : subscriptions
  const fetchedTransactions = capital?.transactions || []
  const memberTransactionHistoryKey = `${refreshKey}:${token}`
  const extraMemberTransactions = !staff && memberTransactionHistory?.key === memberTransactionHistoryKey
    ? memberTransactionHistory.transactions
    : []
  const transactions = staff ? fetchedTransactions : [...fetchedTransactions, ...extraMemberTransactions]
  const memberTransactionsHaveMore = memberTransactionHistory?.key === memberTransactionHistoryKey
    ? memberTransactionHistory.hasMore
    : Boolean(capital?.pagination?.has_more)
  const memberReturns = data?.[1]?.member_returns || []
  const loanInterestReturns = data?.[1]?.loan_interest_returns || []
  const availableReturns = memberReturns.filter((item) => item.claim_status === 'available')
  const availableReturnTotal = availableReturns.reduce((total, item) => total + Number(item.total_return || 0), 0)
  const availableLoanInterestReturns = loanInterestReturns.filter((item) => item.claim_status === 'available')
  const availableLoanInterestTotal = availableLoanInterestReturns.reduce((total, item) => total + Number(item.amount || 0), 0)
  const memberLoanInterestTotal = loanInterestReturns.reduce((total, item) => total + Number(item.amount || 0), 0)
  const loanInterestSummary = data?.[1]?.loan_interest_summary || {}
  const approvedReturnTotal = staff
    ? Number(data?.[1]?.approved_member_returns || 0)
    : memberReturns.reduce((total, item) => total + Number(item.total_return || 0), 0)
  const availableReturnSummary = staff
    ? Number(data?.[1]?.available_member_returns || 0)
    : availableReturnTotal
  const hasOwnInvestorProfile = user.role === 'admin' && Boolean(data?.[1]?.member_profile)
  const summary = capital?.summary || { subscribed_amount: 0, paid_up_amount: 0, unpaid_amount: 0 }
  const lendingBreakdown = data?.[1]?.loan_capital_breakdown

  async function submitMemberContribution(event) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const amount = Number(formData.get('amount'))
    const paymentMethod = String(formData.get('payment_method'))
    const parValue = Number(capital?.share_par_value)
    const amountCents = Math.round(amount * 100)
    const parValueCents = Math.round(parValue * 100)
    if (!Number.isFinite(amount) || amountCents < 1 || !Number.isFinite(parValue) || parValueCents < 1) {
      setActionError('Share-capital terms are not available. Ask cooperative staff to record an approved share subscription first.')
      return
    }
    const shares = Math.ceil(amountCents / parValueCents)
    const subscribedAmount = shares * parValue
    const unpaidAmount = Math.max(0, subscribedAmount - amount)
    if (!window.confirm(
      `Contribute PHP ${formatPesos(amount)} using ${paymentMethod === 'savings' ? 'your savings' : 'Xendit'}? ` +
      `At PHP ${formatPesos(parValue)} per share, this creates a ${shares}-share subscription for PHP ${formatPesos(subscribedAmount)}.` +
      (unpaidAmount > 0 ? ` PHP ${formatPesos(unpaidAmount)} will remain unpaid.` : '')
    )) return

    setNotice('')
    setActionError('')
    setMemberContributionSubmitting(true)
    let subscriptionCreated = false
    try {
      const subscription = await apiRequest('/share-capital/contributions', {
        token,
        method: 'POST',
        body: JSON.stringify({ amount: amount.toFixed(2) }),
      })
      subscriptionCreated = true
      const paymentValues = {
        purpose: 'share_capital',
        payment_method: paymentMethod,
        amount: amount.toFixed(2),
        subscription_id: subscription.subscription_id,
      }
      if (paymentMethod === 'savings') paymentValues.request_id = crypto.randomUUID()
      const payment = await apiRequest('/checkout-transactions', {
        token,
        method: 'POST',
        body: JSON.stringify(paymentValues),
      })
      if (payment.payment_method === 'savings') {
        setNotice(`${payment.message || 'Contribution paid from savings.'} ${unpaidAmount > 0 ? `PHP ${formatPesos(unpaidAmount)} remains unpaid on this subscription.` : ''}`)
        form.reset()
        window.dispatchEvent(new CustomEvent('coopwise:member-profile-updated', {
          detail: { is_investor: true },
        }))
        window.dispatchEvent(new Event('coopwise:refresh'))
      } else if (payment.checkout_url) {
        window.location.assign(payment.checkout_url)
      } else {
        throw new Error('Checkout did not return a payment confirmation or a Xendit checkout link.')
      }
    } catch (requestError) {
      setActionError(subscriptionCreated
        ? `The subscription was created, but checkout did not complete. Check Payments for a pending checkout; cancel it there before cancelling the subscription. ${requestError.message}`
        : requestError.message)
      if (subscriptionCreated) window.dispatchEvent(new Event('coopwise:refresh'))
    } finally {
      setMemberContributionSubmitting(false)
    }
  }

  async function cancelUnpaidSubscription(subscription) {
    if (!window.confirm(`Cancel unpaid share subscription ${subscription.subscription_number}?`)) return
    setNotice('')
    setActionError('')
    setCancellingSubscriptionId(subscription.id)
    try {
      const result = await apiRequest(`/share-capital/subscriptions/${subscription.id}/cancel`, {
        token,
        method: 'POST',
        body: JSON.stringify({}),
      })
      setNotice(result.message)
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setCancellingSubscriptionId(null)
    }
  }

  async function transferSubscriptionToSavings(subscription) {
    const amount = Number(subscription.paid_up_amount)
    if (!window.confirm(
      `Transfer the fully paid subscription ${subscription.subscription_number} (${formatPesos(amount)}) to this account’s savings? ` +
      'The transfer will be recorded in both ledgers. It can proceed only if cooperative lending does not currently require this capital.'
    )) return
    setNotice('')
    setActionError('')
    setTransferringSubscriptionId(subscription.id)
    try {
      const result = await apiRequest(`/share-capital/subscriptions/${subscription.id}/transfer-to-savings`, {
        token,
        method: 'POST',
        body: JSON.stringify({}),
      })
      setNotice(`${result.message} Amount: ${formatPesos(result.amount)}.`)
      if (user.role === 'member') {
        window.dispatchEvent(new CustomEvent('coopwise:member-profile-updated', {
          detail: {
            is_investor: ownSubscriptions.some((item) =>
              Number(item.id) !== Number(subscription.id) && Number(item.paid_up_amount) > 0
            ),
          },
        }))
      }
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setTransferringSubscriptionId(null)
    }
  }

  async function loadMoreShareCapitalTransactions() {
    if (staff || loadingMoreTransactions || !memberTransactionsHaveMore) return
    const nextPage = (memberTransactionHistory?.key === memberTransactionHistoryKey
      ? memberTransactionHistory.page
      : 1) + 1
    setLoadingMoreTransactions(true)
    setActionError('')
    try {
      const result = await apiRequest(`/share-capital?page=${nextPage}&per_page=5`, { token })
      const existingIds = new Set(transactions.map((transaction) => Number(transaction.id)))
      const newTransactions = (result.transactions || [])
        .filter((transaction) => !existingIds.has(Number(transaction.id)))
      setMemberTransactionHistory((current) => ({
        key: memberTransactionHistoryKey,
        page: nextPage,
        hasMore: Boolean(result.pagination?.has_more),
        transactions: [
          ...(current?.key === memberTransactionHistoryKey ? current.transactions : []),
          ...newTransactions,
        ],
      }))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setLoadingMoreTransactions(false)
    }
  }

  async function submitAdminInvestment(event) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    const investmentTotal = Number(values.subscribed_shares) * Number(values.par_value)
    if (!window.confirm(`Confirm that PHP ${investmentTotal.toFixed(2)} was received for ${values.subscribed_shares} share(s)? This will be recorded only as share-capital contribution.`)) return
    setNotice('')
    setActionError('')
    setAdminInvestmentSubmitting(true)
    try {
      const result = await apiRequest('/share-capital/admin-investment', {
        token,
        method: 'POST',
        body: JSON.stringify(values),
      })
      setNotice(`${result.message} Amount: PHP ${result.amount}. Reference: ${result.reference}`)
      form.reset()
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setAdminInvestmentSubmitting(false)
    }
  }

  async function claimReturns(destination) {
    if (returnAction || loanInterestAction || availableReturnTotal <= 0) return
    const destinationLabel = destination === 'savings' ? 'your savings' : 'share capital'
    if (!window.confirm(`Add PHP ${formatPesos(availableReturnTotal)} of approved returns to ${destinationLabel}?`)) return
    setReturnAction(destination)
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/cooperative/returns/claim', {
        token,
        method: 'POST',
        body: JSON.stringify({ destination }),
      })
      setNotice(result.message)
      if (destination === 'share_capital') {
        window.dispatchEvent(new CustomEvent('coopwise:member-profile-updated', {
          detail: { is_investor: true },
        }))
      }
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setReturnAction('')
    }
  }

  async function claimLoanInterestReturns(destination) {
    if (loanInterestAction || returnAction || availableLoanInterestTotal <= 0) return
    const destinationLabel = destination === 'savings' ? 'your savings' : 'share capital'
    if (!window.confirm(
      `Add PHP ${formatPesos(availableLoanInterestTotal)} of equal loan-interest returns to ${destinationLabel}?`
    )) return
    setLoanInterestAction(destination)
    setNotice('')
    setActionError('')
    try {
      const result = await apiRequest('/cooperative/returns/claim', {
        token,
        method: 'POST',
        body: JSON.stringify({ destination, source: 'loan_interest' }),
      })
      setNotice(result.message)
      if (destination === 'share_capital') {
        window.dispatchEvent(new CustomEvent('coopwise:member-profile-updated', {
          detail: { is_investor: true },
        }))
      }
      window.dispatchEvent(new Event('coopwise:refresh'))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setLoanInterestAction('')
    }
  }

  return (
    <section className="portal-section">{/* SECTION - shows portal-section. */}
      {!standalone && <h2>Share capital</h2>}
      <p className="muted">Share capital represents member ownership in the cooperative. It is separate from savings and is not an ordinary savings withdrawal.</p>
      <PortalMessage error>{error || actionError}</PortalMessage>
      {capital && <article className="portal-card cooperative-share-capital-highlight">
        <span>Cooperative-wide paid-up share capital</span>
        <strong>{capital.cooperative_paid_up_amount === undefined
          ? '—'
          : formatPesos(capital.cooperative_paid_up_amount)}</strong>
        <small>Combined ownership contributions from all investors, net of recorded reversals. Lending does not reduce this ownership total.</small>
      </article>}
      {lendingBreakdown && <article className="portal-card capital-lending-summary">
        <div className="capital-lending-summary-heading">
          <div><span className="eyebrow">Cooperative lending</span><span>Available to lend</span></div>
          <strong>{formatPesos(data[1].available_loan_capital)}</strong>
        </div>
        <p className="muted">Loaned principal remains owed to the cooperative. Outstanding and pending loan balances reduce the amount available for new loans, not members’ paid-up ownership.</p>
        <details className="loan-capital-breakdown">
          <summary>View lending capital calculation</summary>
          <dl>
            <div><dt>Paid-up share capital</dt><dd>{formatPesos(lendingBreakdown.paid_up_share_capital)}</dd></div>
            <div><dt>Collected interest available to lend</dt><dd>+ {formatPesos(lendingBreakdown.lendable_interest)}</dd></div>
            <div><dt>Outstanding loan principal</dt><dd>− {formatPesos(lendingBreakdown.outstanding_principal)}</dd></div>
            <div><dt>Pending loan applications</dt><dd>− {formatPesos(lendingBreakdown.pending_principal)}</dd></div>
            <div className="capital-lending-summary-total"><dt>Available to lend</dt><dd>{formatPesos(data[1].available_loan_capital)}</dd></div>
          </dl>
          <small>Loan interest already allocated to investors is excluded from lendable interest.</small>
        </details>
      </article>}
      {capital && <div className="report-grid share-capital-summary">
        <article className="portal-card"><span>Subscribed share capital</span><strong>{formatPesos(summary.subscribed_amount)}</strong></article>
        <article className="portal-card share-capital-total-card">
          <span>{staff ? 'Cooperative paid-up share capital' : 'Your total paid-up share capital'}</span>
          <strong>{formatPesos(summary.paid_up_amount)}</strong>
          <small>{staff ? 'Total member ownership contributions recorded' : 'Your recorded ownership contribution'}</small>
        </article>
        <article className="portal-card dividend-summary-card">
          <span>Approved dividends / member returns</span>
          <strong>{formatPesos(approvedReturnTotal)}</strong>
          <small>{staff ? `Still available to members: ${formatPesos(availableReturnSummary)}` : `Available to allocate: ${formatPesos(availableReturnSummary)}`}</small>
          {!staff && <div className="dividend-action-buttons">
            <button className="button button-outline" type="button" disabled={!availableReturnTotal || Boolean(returnAction) || Boolean(loanInterestAction)} onClick={() => claimReturns('savings')}>{/* BUTTON - add to savings. */}
              {returnAction === 'savings' ? 'Adding…' : 'Add to savings'}
            </button>
            <button className="button button-outline" type="button" disabled={!availableReturnTotal || !ownSubscriptions.some((item) => item.status === 'active') || Boolean(returnAction) || Boolean(loanInterestAction)} onClick={() => claimReturns('share_capital')}>{/* BUTTON - add to share capital. */}
              {returnAction === 'share_capital' ? 'Reinvesting…' : 'Add to share capital'}
            </button>
          </div>}
        </article>
      </div>}
      {data?.[1] && (staff
        ? <article className="portal-card loan-interest-return-summary">
          <span>Loan interest allocated equally to investors</span>
          <strong>{formatPesos(loanInterestSummary.allocated_interest || 0)}</strong>
          <small>
            Available to claim: {formatPesos(loanInterestSummary.available_returns || 0)}
            {' · '}Retained because no eligible investor: {formatPesos(loanInterestSummary.retained_interest || 0)}
          </small>
          <small>Recorded regular loan interest is shared equally among eligible investors. Overdue penalties are kept separate.</small>
        </article>
        : <article className="portal-card loan-interest-return-summary">
          <span>Your loan-interest returns</span>
          <strong>{formatPesos(memberLoanInterestTotal)}</strong>
          <small>Available to claim: {formatPesos(availableLoanInterestTotal)}. Eligible investors receive equal shares of regular loan interest; overdue penalties and annual approved surplus distributions are separate.</small>
          <div className="dividend-action-buttons">
            <button className="button button-outline" type="button" disabled={!availableLoanInterestTotal || Boolean(loanInterestAction) || Boolean(returnAction)} onClick={() => claimLoanInterestReturns('savings')}>{/* BUTTON - add to savings. */}
              {loanInterestAction === 'savings' ? 'Adding…' : 'Add to savings'}
            </button>
            <button className="button button-outline" type="button" disabled={!availableLoanInterestTotal || !ownSubscriptions.some((item) => item.status === 'active') || Boolean(loanInterestAction) || Boolean(returnAction)} onClick={() => claimLoanInterestReturns('share_capital')}>{/* BUTTON - add to share capital. */}
              {loanInterestAction === 'share_capital' ? 'Reinvesting…' : 'Add to share capital'}
            </button>
          </div>
        </article>)}
      {staff && <section>
        <h3>Recent loan-interest allocations</h3>
        <p className="muted">Regular loan interest is allocated among active investors with paid-up share capital. This is separate from approved annual surplus returns.</p>
        {!loading && (data?.[1]?.loan_interest_allocations || []).length === 0 && <p className="muted">No loan-interest allocations have been recorded.</p>}
        {(data?.[1]?.loan_interest_allocations || []).length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Investor</th><th>Loan</th><th>Interest collected</th><th>Investor share</th><th>Investor count</th><th>Status</th><th>Allocated</th></tr></thead>
          <tbody>{data[1].loan_interest_allocations.map((item) => <tr key={`staff-interest-${item.id}`}>
            <td>{item.first_name} {item.last_name}<small>{item.member_number}</small></td>
            <td>{item.loan_code}<small>{item.payment_date}</small></td>
            <td>{formatPesos(item.interest_amount)}</td>
            <td>{formatPesos(item.amount)}</td>
            <td>{item.eligible_investor_count}</td>
            <td>{item.claim_status.replaceAll('_', ' ')}{item.claimed_at && <small>{item.claimed_at}</small>}</td>
            <td>{item.created_at}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>}
      {user.role === 'admin' && <section>
        <h3>Your investor returns</h3>
        <p className="muted">This section shows returns allocated to the admin account’s own linked investor profile, not cooperative-wide totals.</p>
        {!hasOwnInvestorProfile && <p className="muted">No active investor profile is linked to this admin account.</p>}
        {hasOwnInvestorProfile && <>
          <article className="portal-card"><span>Admin savings balance</span><strong>{formatPesos(data?.[1]?.member_savings_balance)}</strong></article>
          <div className="dividend-action-buttons">
            <button className="button button-outline" type="button" disabled={!availableReturnTotal || Boolean(returnAction) || Boolean(loanInterestAction)} onClick={() => claimReturns('savings')}>{/* BUTTON - add to admin savings. */}
              {returnAction === 'savings' ? 'Adding…' : `Add ${formatPesos(availableReturnTotal)} to admin savings`}
            </button>
            <button className="button button-outline" type="button" disabled={!availableReturnTotal || !ownSubscriptions.some((item) => item.status === 'active') || Boolean(returnAction) || Boolean(loanInterestAction)} onClick={() => claimReturns('share_capital')}>{/* BUTTON - reinvest in admin share capital. */}
              {returnAction === 'share_capital' ? 'Reinvesting…' : 'Reinvest in admin share capital'}
            </button>
          </div>
          <p className="muted">Available loan-interest returns: {formatPesos(availableLoanInterestTotal)}</p>
          <div className="dividend-action-buttons">
            <button className="button button-outline" type="button" disabled={!availableLoanInterestTotal || Boolean(loanInterestAction) || Boolean(returnAction)} onClick={() => claimLoanInterestReturns('savings')}>{/* BUTTON - add loan-interest returns to admin savings. */}
              {loanInterestAction === 'savings' ? 'Adding…' : 'Add loan-interest returns to admin savings'}
            </button>
            <button className="button button-outline" type="button" disabled={!availableLoanInterestTotal || !ownSubscriptions.some((item) => item.status === 'active') || Boolean(loanInterestAction) || Boolean(returnAction)} onClick={() => claimLoanInterestReturns('share_capital')}>{/* BUTTON - reinvest loan-interest returns. */}
              {loanInterestAction === 'share_capital' ? 'Reinvesting…' : 'Reinvest loan-interest returns'}
            </button>
          </div>
          {loanInterestReturns.length > 0 && <div className="table-wrap"><table>
            <thead><tr><th>Loan</th><th>Interest collected</th><th>Investor share</th><th>Investor count</th><th>Status</th><th>Allocated</th></tr></thead>
            <tbody>{loanInterestReturns.map((item) => <tr key={`interest-${item.id}`}>
              <td>{item.loan_code}<small>{item.reference_no}</small></td>
              <td>{formatPesos(item.interest_amount)}</td>
              <td>{formatPesos(item.amount)}</td>
              <td>{item.eligible_investor_count}</td>
              <td>{item.claim_status.replaceAll('_', ' ')}{item.claimed_at && <small>{item.claimed_at}</small>}</td>
              <td>{item.created_at}</td>
            </tr>)}</tbody>
          </table></div>}
          {!loading && memberReturns.length === 0 && <p className="muted">No approved member returns have been recorded for this investor profile.</p>}
          {memberReturns.length > 0 && <div className="table-wrap"><table>
            <thead><tr><th>Fiscal year</th><th>Share capital basis</th><th>Interest on share capital</th><th>Patronage basis</th><th>Patronage refund</th><th>Total return</th><th>Status</th></tr></thead>
            <tbody>{memberReturns.map((item) => <tr key={item.id}>
              <td>{item.fiscal_year}<small>Approved {item.approved_at}</small></td>
              <td>{formatPesos(item.paid_up_share_capital)}</td>
              <td>{formatPesos(item.interest_on_share_capital)}</td>
              <td>{formatPesos(item.patronage_basis)}</td>
              <td>{formatPesos(item.patronage_refund)}</td>
              <td>{formatPesos(item.total_return)}</td>
              <td>{item.claim_status.replaceAll('_', ' ')}{item.claimed_at && <small>{item.claimed_at}</small>}</td>
            </tr>)}</tbody>
          </table></div>}
        </>}
      </section>}
      {!staff && <details className="portal-card member-share-contribution">
        <summary>+ Contribute to share capital</summary>
        {loading && !capital
          ? <PortalSkeleton kind="cards" rows={1} label="Loading share terms" />
          : capital?.share_par_value
          ? <p className="muted">Current par value: {formatPesos(capital.share_par_value)} per share.</p>
          : <p className="message message-error">Share-capital terms are not configured. Ask cooperative staff to record an approved share subscription first.</p>}
        <div className="contribution-savings-balance">
          <span>Available savings</span>
          <strong>{loading && savingsBalance === undefined ? 'Loading…' : formatPesos((savingsBalance || 0) / 100)}</strong>
        </div>
        <form className="form-grid" onSubmit={submitMemberContribution}>{/* FORM - records a member contribution to the cooperative cycle. */}
          <label>Contribution amount (PHP)<input name="amount" type="number" min="0.01" max="9999999999.99" step="0.01" required /></label>
          <label>Pay using<select name="payment_method" defaultValue="xendit" required>
            <option value="xendit">Xendit checkout</option>
            <option value="savings">Available savings</option>
          </select></label>
          <button className="button button-primary full" type="submit" disabled={memberContributionSubmitting || !capital?.share_par_value}>{/* BUTTON - contribute to share capital. */}
            {memberContributionSubmitting ? 'Preparing contribution…' : 'Contribute to share capital'}
          </button>
        </form>
      </details>}
      {!staff && <section>
        <h3>Your loan-interest return history</h3>
        <p className="muted">Each recorded regular-interest payment is split equally among active members with paid-up share capital. Overdue penalties and annual surplus distributions are tracked separately.</p>
        {!loading && loanInterestReturns.length === 0 && <p className="muted">No loan-interest returns have been allocated to your investor profile.</p>}
        {loanInterestReturns.length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Loan</th><th>Interest collected</th><th>Your equal share</th><th>Investor count</th><th>Status</th><th>Allocated</th></tr></thead>
          <tbody>{loanInterestReturns.map((item) => <tr key={`interest-${item.id}`}>
            <td>{item.loan_code}<small>{item.reference_no}</small></td>
            <td>{formatPesos(item.interest_amount)}</td>
            <td>{formatPesos(item.amount)}</td>
            <td>{item.eligible_investor_count}</td>
            <td>{item.claim_status.replaceAll('_', ' ')}{item.claimed_at && <small>{item.claimed_at}</small>}</td>
            <td>{item.created_at}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>}
      {!staff && <section>
        <h3>Approved member returns</h3>
        <p className="muted">These are approved interest-on-share-capital and patronage-refund allocations. They are separate from your share-capital balance and savings balance.</p>
        {!loading && memberReturns.length === 0 && <p className="muted">No approved member returns have been recorded for your account.</p>}
        {memberReturns.length > 0 && <div className="table-wrap"><table>
          <thead><tr><th>Fiscal year</th><th>Share capital basis</th><th>Interest on share capital</th><th>Patronage basis</th><th>Patronage refund</th><th>Total return</th><th>Status</th></tr></thead>
          <tbody>{memberReturns.map((item) => <tr key={item.id}>
            <td>{item.fiscal_year}<small>Approved {item.approved_at}</small></td>
            <td>{formatPesos(item.paid_up_share_capital)}</td>
            <td>{formatPesos(item.interest_on_share_capital)}</td>
            <td>{formatPesos(item.patronage_basis)}</td>
            <td>{formatPesos(item.patronage_refund)}</td>
            <td>{formatPesos(item.total_return)}</td>
            <td>{item.claim_status.replaceAll('_', ' ')}{item.claimed_at && <small>{item.claimed_at}</small>}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>}
      {staff && capital && <>
        {user.role === 'admin' && <details className="portal-card">
          <summary>Contribute to share capital</summary>
          <p className="muted">Record the admin account’s own share-capital contribution. This creates a linked investor profile if needed and records only share-capital ownership—no savings account, loan access, or other member services are enabled.</p>
          <form className="form-grid" onSubmit={submitAdminInvestment}>{/* FORM - records the admin share-capital contribution. */}
            <label>Shares to purchase<input name="subscribed_shares" type="number" min="1" step="1" required /></label>
            <label>Par value per share (PHP)<input name="par_value" type="number" min="0.01" step="0.01" required /></label>
            <label>Payment received via<select name="payment_method" defaultValue="cash" required>
              <option value="cash">Cash</option>
              <option value="bank">Bank transfer</option>
              <option value="gcash">GCash</option>
              <option value="check">Check</option>
            </select></label>
            <button className="button button-primary" type="submit" disabled={adminInvestmentSubmitting}>{/* BUTTON - record admin contribution. */}
              {adminInvestmentSubmitting ? 'Recording contribution…' : 'Record admin contribution'}
            </button>
          </form>
        </details>}
      </>}
      <h3>Share subscriptions</h3>
      {loading && !capital && <PortalSkeleton rows={5} columns={staff ? 8 : 7} label="Loading share subscriptions" />}
      {!loading && capital && !subscriptions.length && <StaffEmptyState type="members" title="No subscriptions recorded" description={staff ? 'Members can contribute directly using the cooperative-approved share terms.' : 'Your share subscriptions will appear here after you start a contribution.'} />}
      {subscriptions.length > 0 && <div className="table-wrap"><table>
        <thead><tr>{staff && <th>Member</th>}<th>Subscription</th><th>Shares × par value</th><th>Subscribed</th><th>Paid up</th><th>Unpaid</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{subscriptions.map((item) => <tr key={item.id}>
          {staff && <td>{item.member_number} · {item.first_name} {item.last_name}</td>}
          <td>{item.subscription_number}<small>{item.subscription_date}</small></td>
          <td>{item.subscribed_shares} × {formatPesos(item.par_value)}</td>
          <td>{formatPesos(item.subscribed_amount)}</td>
          <td>{formatPesos(item.paid_up_amount)}</td>
          <td>{formatPesos(item.unpaid_amount)}</td>
          <td><span className={`status status-${item.status}`}>{item.status}</span>
            {Number(item.pending_payment_amount) > 0 && <small>Cancel the pending checkout in Payments first.</small>}</td>
          <td>
            {item.status === 'active' && Number(item.paid_up_amount) === 0 && Number(item.pending_payment_amount) === 0 && <button
              className="text-button"
              type="button"
              disabled={cancellingSubscriptionId === item.id}
              onClick={() => cancelUnpaidSubscription(item)}
            >{cancellingSubscriptionId === item.id ? 'Cancelling…' : 'Cancel'}</button>}
            {(user.role === 'member' || (user.role === 'admin' && Number(item.owner_user_id) === Number(user.id)))
              && item.status === 'active'
              && Number(item.paid_up_amount) > 0
              && Number(item.paid_up_amount) === Number(item.subscribed_amount)
              && Number(item.pending_payment_amount) === 0
              && <button className="text-button" type="button" disabled={transferringSubscriptionId === item.id} onClick={() => transferSubscriptionToSavings(item)}>
                {transferringSubscriptionId === item.id ? 'Transferring…' : 'Transfer to savings'}
              </button>}
          </td>
        </tr>)}</tbody>
      </table></div>}
      <h3>Contribution history</h3>
      {!loading && capital && !transactions.length && <p className="muted">No share capital transactions have been recorded.</p>}
      {transactions.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>Date / reference</th>{staff && <th>Member</th>}<th>Subscription</th><th>Activity</th><th>Amount</th><th>Paid-up balance</th><th>Method / reason</th></tr></thead>
        <tbody>{transactions.map((transaction) => <tr key={transaction.id}>
          <td>{transaction.created_at}<small>{transaction.transaction_reference}</small></td>
          {staff && <td>{transaction.member_number} · {transaction.first_name} {transaction.last_name}</td>}
          <td>{transaction.subscription_number}</td>
          <td>{transaction.transaction_type === 'reversal' ? `Reversal of #${transaction.reverses_transaction_id}` : 'Contribution'}</td>
          <td>{transaction.transaction_type === 'reversal' ? '−' : ''}{formatPesos(transaction.amount)}</td>
          <td>{formatPesos(transaction.balance_after)}</td>
          <td>{transaction.payment_method || transaction.description || '—'}</td>
        </tr>)}</tbody>
      </table></div>}
      {staff && capital?.pagination && <div className="pagination-controls" aria-label="Share capital history pages">
        <button className="button button-outline" type="button" disabled={transactionsPage <= 1 || loading} onClick={() => setTransactionsPage((page) => page - 1)}>{/* BUTTON - previous. */}Previous</button>
        <span>Page {transactionsPage}</span>
        <button className="button button-outline" type="button" disabled={!capital.pagination.has_more || loading} onClick={() => setTransactionsPage((page) => page + 1)}>{/* BUTTON - next. */}Next</button>
      </div>}
      {!staff && memberTransactionsHaveMore && <div className="load-more-row">
        <button className="button button-outline" type="button" disabled={loadingMoreTransactions || loading} onClick={loadMoreShareCapitalTransactions}>{/* BUTTON - load more contributions. */}
          {loadingMoreTransactions ? 'Loading…' : 'Load more contributions'}
        </button>
      </div>}
    </section>
  )
}

// This block explains the cooperative features used in this project.
function LearningCenter({ token, user, refreshKey, standalone = false }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const { data, error, loading } = usePortalData(token, refreshKey, POLICY_ENDPOINTS)
  const [policyDraft, setPolicyDraft] = useState(null)
  const setNotice = dispatchActionToast
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
    <p className="muted">A cooperative is owned and used by its members. Members participate in services and help shape the cooperative according to its bylaws and policies. CoopWise is not a bank or a substitute for your cooperative’s official rules.</p>
    <div className="learning-grid">
      <article className="portal-card"><span className="eyebrow">01 · Membership</span><h3>Members are owners</h3><p>Members join under the cooperative’s membership rules, use services, and share responsibility for the organization. Membership is more than having a login.</p></article>
      <article className="portal-card"><span className="eyebrow">02 · Share capital</span><h3>Ownership, not wallet money</h3><p>Share capital represents a member’s ownership contribution. CoopWise tracks subscriptions and paid-up amounts separately from available savings.</p></article>
      <article className="portal-card"><span className="eyebrow">03 · Loans</span><h3>Borrow from available cooperative capital</h3><p>Loan offers are limited by paid-up share capital and collected loan interest, less outstanding principal and pending applications. Repaying principal makes that capital available again.</p></article>
      <article className="portal-card"><span className="eyebrow">04 · Paluwagan</span><h3>Contribute to a rotating pool</h3><p>Enrolled members contribute to a scheduled cycle. The system tracks the order and contributions; staff confirm the simulated payout to the next recipient.</p></article>
      <article className="portal-card"><span className="eyebrow">05 · Payments</span><h3>Review payment records</h3><p>Online payment records are added after provider confirmation. CoopWise withdrawals update the savings ledger; they do not initiate an external bank or e-wallet transfer.</p></article>
      <article className="portal-card"><span className="eyebrow">06 · Records</span><h3>Keep the history clear</h3><p>Each balance credit or debit should have a source and reference. Share capital stays separate, and corrections should be recorded with a reason rather than deleting history.</p></article>
      <article className="portal-card"><span className="eyebrow">07 · Member returns</span><h3>Surplus and loan-interest returns are different</h3><p>Annual surplus distributions require cooperative review and approval; they may include interest on share capital and patronage refunds. In this CoopWise simulation, regular loan interest is separately allocated equally among active investors with paid-up share capital when collected. Overdue penalties are excluded, and these equal loan-interest returns are not a guaranteed annual dividend.</p></article>
    </div>
    <section className="policy-section">{/* SECTION - shows policy-section. */}
      <div className="section-heading"><div><h3>Cooperative policies for this demo</h3><p className="muted">These are this project’s sample rules, not universal cooperative rules or legal advice.</p></div></div>
      <PortalMessage error>{error || actionError}</PortalMessage>
      {loading && !policies && <p className="muted">Loading current demo policies…</p>}
      {!loading && !policies && !error && <p className="muted">No demo policies have been published.</p>}
      {policies && staff && <form className="portal-card form-grid policy-form" onSubmit={savePolicies}>
        {policyFields.map(([key, label]) => <label className="full" key={key}>{label} policy
          <textarea rows="4" maxLength="5000" required value={policies[key] || ''} onChange={(event) => setPolicyDraft({ ...policies, [key]: event.target.value })} />
        </label>)}
        <div className="full">
          <h4>Configurable sample loan eligibility</h4>
          <p className="muted">These are this demonstration cooperative’s rules, not universal legal requirements. Loan principal uses cooperative capital and reduces the amount available for other loans until repayments are received.</p>
        </div>
        <label>Minimum membership period (days)<input type="number" min="0" max="3650" step="1" required value={policies.minimum_membership_days ?? 30} onChange={(event) => setPolicyDraft({ ...policies, minimum_membership_days: event.target.value })} /></label>
        <label>Minimum paid-up share capital (PHP)<input type="number" min="0" step="0.01" required value={policies.minimum_paid_up_share_capital ?? '5000.00'} onChange={(event) => setPolicyDraft({ ...policies, minimum_paid_up_share_capital: event.target.value })} /></label>
        <label>Minimum savings balance (PHP)<input type="number" min="0" step="0.01" required value={policies.minimum_savings_balance ?? '0.00'} onChange={(event) => setPolicyDraft({ ...policies, minimum_savings_balance: event.target.value })} /></label>
        <label>Maximum loan ÷ paid-up share capital<input type="number" min="0" max="100" step="0.01" required value={policies.loan_to_paid_up_share_capital_multiplier ?? '1.00'} onChange={(event) => setPolicyDraft({ ...policies, loan_to_paid_up_share_capital_multiplier: event.target.value })} /></label>
        <label className="full">Cooperative registration date (required for surplus distribution)<input type="date" max={TODAY} value={policies.cooperative_registration_date || ''} onChange={(event) => setPolicyDraft({ ...policies, cooperative_registration_date: event.target.value })} /><small>Used to apply the first-five-years reserve rule when staff prepare an annual surplus distribution.</small></label>
        <button className="button button-primary" type="submit" disabled={!policyDraft}>{/* BUTTON - save demo policies. */}Save demo policies</button>
        {policies.updated_at && <small className="full">Last updated: {policies.updated_at}</small>}
      </form>}
      {policies && !staff && <div className="policy-grid">
        {policyFields.map(([key, label]) => <article className="portal-card" key={key}><h4>{label}</h4><p>{policies[key]}</p></article>)}
        <article className="portal-card"><h4>Loan eligibility sample rules</h4>
          <p>Minimum membership: {policies.minimum_membership_days} days. Minimum paid-up share capital: {formatPesos(policies.minimum_paid_up_share_capital)}. Minimum savings: {formatPesos(policies.minimum_savings_balance)}. Maximum loan limit: {policies.loan_to_paid_up_share_capital_multiplier} × paid-up share capital, less any current loan balance.</p>
          <p>These are the current configured sample rules. Eligibility allows you to apply; staff review and available cooperative share capital still determine whether a loan is approved.</p>
        </article>
        {policies.updated_at && <small>Last updated: {policies.updated_at}</small>}
      </div>}
    </section>
  </section>
}

// This block walks the user through the classroom demonstration.
function DemoGuide({ setSection, standalone = false }) {
  const steps = [
    { title: 'Understand the cooperative', section: 'learning', description: 'Learn what membership, share capital, loans, and Paluwagan mean in this classroom demo.' },
    { title: 'Compare sample loan offers', section: 'loans', description: 'Review the example interest rate and repayment schedule before applying. Staff review the application.' },
    { title: 'Explore a Paluwagan cycle', section: 'cooperative', description: 'See the contribution amount, randomized order, daily records, and payout status.' },
    { title: 'Review your balance sources', section: 'savings', description: 'An approved loan is funded from cooperative lending capital and credits your demo savings. Principal repayments restore lending capacity; regular interest is allocated separately to eligible investors.' },
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
      <button className="button button-outline" type="button" onClick={() => setSection(step.section)}>{/* BUTTON - open section. */}Open section</button>
    </li>)}</ol>
  </section>
}

// This block draws a chart from the report data.
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

// This block shows the details saved in an activity record.
function ActivityDetails({ details }) {
  if (!details) return '—'

  let value = details
  if (typeof details === 'string') {
    try {
      value = JSON.parse(details)
    } catch {
      value = details
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return '—'
    return <dl className="activity-details-list">
      {entries.map(([key, entryValue]) => <div key={key}>
        <dt>{key.replaceAll('_', ' ')}</dt>
        <dd>{entryValue == null
          ? '—'
          : typeof entryValue === 'object'
            ? JSON.stringify(entryValue)
            : String(entryValue)}</dd>
      </div>)}
    </dl>
  }

  return <span className="activity-details-text">
    {typeof value === 'string' ? value : JSON.stringify(value)}
  </span>
}

// This block shows cooperative reports and recent activity.
function ReportsPortal({ token, refreshKey, standalone = false }) {
  const { data, error, loading } = usePortalData(token, refreshKey, REPORT_ENDPOINTS)
  const report = data?.[0]
  const [actionError, setActionError] = useState('')
  const [loadedActivityHistory, setLoadedActivityHistory] = useState(null)
  const [loadingMoreActivity, setLoadingMoreActivity] = useState(false)
  const activityHistory = loadedActivityHistory?.refreshKey === refreshKey ? loadedActivityHistory : null
  const activityLogs = [
    ...(report?.activity_logs || []),
    ...(activityHistory?.entries || []),
  ]
  const activityPage = activityHistory?.page || 1
  const activityHasMore = activityHistory?.hasMore ?? Boolean(report?.activity_pagination?.has_more)
  const financialChartRows = useMemo(() => report ? [
    ['Activity', 'PHP'],
    ['Savings deposits', Number(report.monthly.savings_deposits) || 0],
    ['Savings withdrawals', Number(report.monthly.savings_withdrawals) || 0],
    ['Share capital contributions', Number(report.monthly.share_capital_payments) || 0],
    ['Loan principal repaid', Number(report.monthly.loan_principal_received) || 0],
    ['Loan interest received', Number(report.monthly.loan_interest_received) || 0],
  ] : [], [report])
  async function loadMoreActivity() {
    if (loadingMoreActivity || !activityHasMore) return
    const nextPage = activityPage + 1
    setLoadingMoreActivity(true)
    setActionError('')
    try {
      const result = await apiRequest(`/reports/activity?activity_page=${nextPage}&activity_per_page=5`, { token })
      const existingIds = new Set(activityLogs.map((entry) => Number(entry.id)))
      const newEntries = (result.activity_logs || [])
        .filter((entry) => !existingIds.has(Number(entry.id)))
      setLoadedActivityHistory((current) => ({
        refreshKey,
        page: nextPage,
        hasMore: Boolean(result.pagination?.has_more),
        entries: [
          ...(current?.refreshKey === refreshKey ? current.entries : []),
          ...newEntries,
        ],
      }))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setLoadingMoreActivity(false)
    }
  }

  return (
    <section className="portal-section">{/* SECTION - shows portal-section. */}
      <PortalMessage error>{error}</PortalMessage>
      <PortalMessage error>{actionError}</PortalMessage>
      {!report && loading && <PortalSkeleton kind="metrics" rows={4} label="Loading report figures" />}
      {!report && !loading && !error && <StaffEmptyState
        type="report"
        title="No report figures yet."
        description="Recorded cooperative totals will appear here."
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
          <article className="portal-card"><span>Cooperative lending capital available</span><strong>{formatPesos(report.summary.available_loan_capital)}</strong><small>Paid-up share capital + unallocated collected interest − outstanding and pending principal.</small></article>
          <article className="portal-card"><span>Collected interest still lendable</span><strong>{formatPesos(report.summary.lendable_loan_interest)}</strong></article>
          <article className="portal-card"><span>Loan interest allocated to investors</span><strong>{formatPesos(report.summary.distributed_loan_interest)}</strong></article>
          <article className="portal-card"><span>Pending loan principal reserve</span><strong>{formatPesos(report.summary.pending_loan_principal)}</strong></article>
          <article className="portal-card"><span>Loan payments received</span><strong>PHP {report.summary.loan_payments_received}</strong></article>
          <article className="portal-card"><span>Loan interest received</span><strong>{formatPesos(report.summary.loan_interest_received)}</strong></article>
          <article className="portal-card"><span>Approved member returns</span><strong>{formatPesos(report.summary.approved_member_returns)}</strong></article>
        </div>
        <h3>Operational overview</h3>
        <ul className="operational-overview-list">
          <li><span>Loan applications awaiting review</span><strong>{report.operations?.loans_awaiting_review ?? '—'}</strong></li>
          <li><span>Document sets awaiting review</span><strong>{report.operations?.documents_awaiting_review ?? '—'}</strong></li>
          <li><span>Active Paluwagan cycles</span><strong>{report.operations?.active_paluwagan_cycles ?? '—'}</strong></li>
          <li><span>Payouts awaiting confirmation</span><strong>{report.operations?.payouts_awaiting_confirmation ?? '—'}</strong></li>
          <li><span>Overdue installments <small>Outstanding: PHP {report.operations?.overdue_installment_balance ?? '—'}</small></span><strong>{report.operations?.overdue_installment_count ?? '—'}</strong></li>
        </ul>
        <h3>Visual summaries</h3>
        <p className="muted">This chart summarizes cooperative-wide monthly financial activity; it does not display member names or account-level details. Loan application counts are available in Loans.</p>
        <div className="report-chart-grid">
          <GoogleReportChart title={`Monthly financial activity · ${report.period}`} rows={financialChartRows} />
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
        <h3>Recent activity</h3>
        {activityLogs.length ? <div className="table-wrap"><table className="recent-activity-table">
          <thead><tr><th>Date</th><th>Actor</th><th>Area</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>{activityLogs.map((entry) => <tr key={entry.id}>
            <td>{entry.created_at}</td>
            <td>{entry.actor_name || 'System'}<small>{entry.actor_role || 'automated'}</small></td>
            <td>{entry.module}</td>
            <td>{entry.action}</td>
            <td><ActivityDetails details={entry.details} /></td>
          </tr>)}</tbody>
        </table></div> : <p className="muted">No staff activity has been recorded.</p>}
        {activityHasMore && <button className="button button-outline" type="button" onClick={loadMoreActivity} disabled={loadingMoreActivity}>
          {loadingMoreActivity ? 'Loading…' : 'Load more activity'}
        </button>}
      </>}
    </section>
  )
}

// This block shows payment choices and payment history.
function PaymentPortal({ token, user, refreshKey, standalone = false, initialPurpose = 'loan' }) {
  const staff = ['admin', 'officer'].includes(user.role)
  const [transactionsPage, setTransactionsPage] = useState(1)
  const [memberTransactionHistory, setMemberTransactionHistory] = useState(null)
  const [loadingMoreTransactions, setLoadingMoreTransactions] = useState(false)
  const endpoints = useMemo(() => PAYMENT_ENDPOINTS.map((path) =>
    path === '/checkout-transactions'
      ? `${path}?page=${staff ? transactionsPage : 1}&per_page=${staff ? 25 : 10}`
      : path
  ), [staff, transactionsPage])
  const { data, error, loading, refreshEndpoint } = usePortalData(token, refreshKey, endpoints)
  const setNotice = dispatchActionToast
  const [actionError, setActionError] = useState('')
  const [purpose, setPurpose] = useState(initialPurpose)
  const [paymentMethod, setPaymentMethod] = useState('xendit')
  const [selectedLoanId, setSelectedLoanId] = useState('')
  const [paymentAmount, setPaymentAmount] = useState('')
  const savingsPaymentRequest = useRef(null)
  const [submitting, setSubmitting] = useState(false)
  const [slowCheckout, setSlowCheckout] = useState(false)
  const [checkingPayment, setCheckingPayment] = useState(null)
  const [cancellingPayment, setCancellingPayment] = useState(null)
  const [replacementPayment, setReplacementPayment] = useState(null)
  const loans = data?.[0]?.loans || []
  const cycles = data?.[1]?.cycles || []
  const subscriptions = data?.[2]?.subscriptions || []
  const fetchedTransactions = data?.[3]?.transactions || []
  const memberTransactionHistoryKey = `${refreshKey}:${token}`
  const additionalMemberTransactions = !staff && memberTransactionHistory?.key === memberTransactionHistoryKey
    ? memberTransactionHistory.transactions
    : []
  const transactions = staff ? fetchedTransactions : [...fetchedTransactions, ...additionalMemberTransactions]
  const transactionsPagination = data?.[3]?.pagination
  const memberTransactionsHaveMore = memberTransactionHistory?.key === memberTransactionHistoryKey
    ? memberTransactionHistory.hasMore
    : Boolean(transactionsPagination?.has_more)
  const savingsBalance = data?.[4]?.balance
  const selectedLoan = loans.find((loan) => String(loan.id) === selectedLoanId)
  const maximumLoanPayment = selectedLoan
    ? Number(selectedLoan.available_repayment_amount ?? selectedLoan.current_balance)
    : 0
  const effectivePaymentMethod = purpose === 'savings' ? 'xendit' : paymentMethod
  const hasUnsettledCheckout = transactions.some((transaction) =>
    transaction.status === 'pending' || (transaction.status === 'needs_review' && transaction.checkout_url)
  )

  useEffect(() => {
    let active = true
    const params = new URLSearchParams(window.location.search)
    const result = params.get('payment')
    const transactionId = params.get('transaction')
    if (result === 'success') {
      setNotice('The payment provider returned you to CoopWise. We are verifying the transaction; your account updates after provider confirmation.')
    } else if (result === 'cancelled') {
      setNotice('Checkout was cancelled. No payment has been added to your account.')
    }
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
              if (response.status === 'paid') {
                apiRequest('/me', { token })
                  .then((profile) => {
                    if (active && typeof profile.user?.member?.is_investor === 'boolean') {
                      window.dispatchEvent(new CustomEvent('coopwise:member-profile-updated', {
                        detail: { is_investor: profile.user.member.is_investor },
                      }))
                    }
                  })
                  .catch((requestError) => {
                    if (active) setActionError(`Payment was confirmed, but investor status could not be refreshed: ${requestError.message}`)
                  })
              }
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
  }, [setNotice, token])

  useEffect(() => {
    if (staff || !hasUnsettledCheckout) return undefined

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshEndpoint(`/checkout-transactions?page=1&per_page=10`).catch((requestError) => setActionError(requestError.message))
      }
    }, 10000)
    return () => window.clearInterval(interval)
  }, [refreshEndpoint, staff, hasUnsettledCheckout, transactionsPage])

  async function loadMorePaymentTransactions() {
    if (staff || loadingMoreTransactions || !memberTransactionsHaveMore) return
    const nextPage = (memberTransactionHistory?.key === memberTransactionHistoryKey
      ? memberTransactionHistory.page
      : 1) + 1
    setLoadingMoreTransactions(true)
    setActionError('')
    try {
      const result = await apiRequest(`/checkout-transactions?page=${nextPage}&per_page=10`, { token })
      const existingIds = new Set(transactions.map((transaction) => Number(transaction.id)))
      const newTransactions = (result.transactions || [])
        .filter((transaction) => !existingIds.has(Number(transaction.id)))
      setMemberTransactionHistory((current) => ({
        key: memberTransactionHistoryKey,
        page: nextPage,
        hasMore: Boolean(result.pagination?.has_more),
        transactions: [
          ...(current?.key === memberTransactionHistoryKey ? current.transactions : []),
          ...newTransactions,
        ],
      }))
    } catch (requestError) {
      setActionError(requestError.message)
    } finally {
      setLoadingMoreTransactions(false)
    }
  }

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
        setPaymentAmount('')
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
      setSelectedLoanId(String(transaction.loan_id || ''))
      setPaymentAmount(String(transaction.amount || ''))
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
    <section className="portal-section">{/* SECTION - shows portal-section. */}
      {!staff && !standalone && <div className="section-heading">
        <div>
          <div className="eyebrow">Secure checkout</div>
          <h2>Make a payment</h2>
          <p className="muted">Choose what to pay and whether to use Xendit or your available savings balance.</p>
        </div>
      </div>}
      <PortalMessage error>{error || actionError}</PortalMessage>
      {!staff && (
        <div className="payment-available-savings">
          <span>Available savings</span>
          <strong>{savingsBalance === undefined || savingsBalance === null ? 'Loading…' : formatPesos(savingsBalance / 100)}</strong>
        </div>
      )}
      {!staff && (
        <form className="portal-card form-grid" key={replacementPayment?.transaction_id || 'new-payment'} onSubmit={startCheckout}>{/* FORM - starts checkout for the selected payment. */}
          <label>Payment method
            <select name="payment_method" value={purpose === 'savings' ? 'xendit' : paymentMethod} disabled={purpose === 'savings'} onChange={(event) => setPaymentMethod(event.target.value)} required>
              <option value="xendit">Xendit checkout</option>
              <option value="savings">Deduct from savings</option>
            </select>
          </label>
          <label>Payment for
            <select value={purpose} onChange={(event) => {
              setPurpose(event.target.value)
              setPaymentAmount('')
              if (event.target.value !== 'loan') setSelectedLoanId('')
            }} required>
              <option value="loan">Loan repayment</option>
              <option value="paluwagan">Paluwagan contribution</option>
              <option value="share_capital">Share-capital contribution</option>
              <option value="savings">Deposit to savings</option>
            </select>
          </label>
          {purpose === 'loan' && (
            <label>Loan
              <select name="loan_id" required value={selectedLoanId} onChange={(event) => {
                setSelectedLoanId(event.target.value)
                setPaymentAmount('')
              }}>
                <option value="" disabled>Select a loan</option>
                {loans.filter((loan) => ['approved', 'active'].includes(loan.status)).map((loan) => <option key={loan.id} value={loan.id}>{loan.loan_code} · Balance PHP {loan.current_balance}{Number(loan.available_repayment_amount ?? loan.current_balance) < Number(loan.current_balance) ? ` · Available PHP ${loan.available_repayment_amount}` : ''}</option>)}
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
          <div className="payment-amount-field">
            <label>Amount (PHP)<input
              name="amount"
              type="number"
              min={purpose === 'loan' ? '0.01' : '1.00'}
              max={purpose === 'loan' ? maximumLoanPayment : '1000000.00'}
              step="0.01"
              required
              value={paymentAmount}
              onChange={(event) => {
                const rawAmount = event.target.value
                if (purpose === 'loan' && rawAmount) {
                  const maximumCents = Math.max(0, Math.round(maximumLoanPayment * 100))
                  const enteredCents = Math.round(Number(rawAmount) * 100)
                  setPaymentAmount(
                    Number.isFinite(enteredCents) && enteredCents > maximumCents
                      ? (maximumCents / 100).toFixed(2)
                      : rawAmount
                  )
                  return
                }
                setPaymentAmount(rawAmount)
              }}
            /></label>
            {purpose === 'loan' && <button className="button button-outline" type="button" disabled={!selectedLoan || maximumLoanPayment < 0.01} onClick={() => setPaymentAmount(maximumLoanPayment.toFixed(2))}>Full</button>}
          </div>
          {purpose === 'paluwagan' && <p className="full muted">The amount must equal the selected cycle’s daily contribution. Only one payment is accepted per member per day.</p>}
          <button className="button button-primary full" type="submit" disabled={submitting}>{/* BUTTON - continue to payment provider. */}{submitting
            ? (effectivePaymentMethod === 'xendit' ? 'Opening secure checkout…' : 'Processing savings payment…')
            : (effectivePaymentMethod === 'xendit' ? 'Continue to payment provider' : 'Pay from savings')}</button>
          {submitting && effectivePaymentMethod === 'xendit' && <p className="full muted" role="status">{slowCheckout
            ? 'The payment service is taking longer than usual to respond. Please wait; do not click again. No payment is recorded until you complete the provider checkout.'
            : 'Connecting securely to Xendit. Please wait before leaving this page.'}</p>}
        </form>
      )}
      <div className="item-heading"><h3>{staff ? 'All member transactions' : 'Your transactions'}</h3>
        <button className="button button-outline" type="button" onClick={() => window.dispatchEvent(new Event('coopwise:refresh'))}>{/* BUTTON - refresh. */}Refresh</button>
      </div>
      {loading && transactions.length === 0 && <PortalSkeleton rows={5} columns={staff ? 8 : 7} label="Loading payment transactions" />}
      {!loading && !error && transactions.length === 0 && <StaffEmptyState type="payment" title="No payment transactions yet." description="Completed Xendit payments, staff-recorded repayments, savings deposits, and savings-funded payments will appear here." />}
      {transactions.length > 0 && <div className="table-wrap"><table>
        <thead><tr>{staff && <th>Member</th>}<th>Date</th><th>Purpose</th><th>Amount</th><th>Payment method</th>{staff && <th>Provider fee / net</th>}<th>Reference</th><th>Status</th>{!staff && <th>Action</th>}</tr></thead>
        <tbody>{transactions.map((transaction) => <tr key={transaction.id}>
          {staff && <td>{transaction.member_number} · {transaction.first_name} {transaction.last_name}</td>}
          <td>{transaction.paid_at || transaction.created_at}</td>
          <td>{transaction.purpose === 'savings' ? 'Savings deposit' : transaction.purpose.replace('_', ' ')}</td>
          <td>{formatPesos(transaction.amount)}</td>
          <td>{transaction.payment_method === 'staff' ? 'Recorded by staff' : transaction.payment_method === 'savings' ? 'Savings balance' : 'Xendit'}</td>
          {staff && <td>{transaction.provider_fee === null ? '—' : `${formatPesos(transaction.provider_fee)} fee · ${formatPesos(transaction.net_amount)} net`}</td>}
          <td>{transaction.reference_no}</td>
          <td><span className={`status status-${transaction.status}`}>{transaction.status.replace('_', ' ')}</span>
            {transaction.review_note && <small>{transaction.review_note}</small>}</td>
          {!staff && <td>{['pending', 'needs_review'].includes(transaction.status) && <>
            {transaction.checkout_url && <a className="text-button" href={transaction.checkout_url} target="_blank" rel="noreferrer">Open checkout</a>}
            <button className="text-button" type="button" disabled={checkingPayment === transaction.id} onClick={() => refreshPayment(transaction)}>{/* BUTTON - check status. */}{checkingPayment === transaction.id ? 'Checking…' : 'Check status'}</button>
            {transaction.status === 'pending' && transaction.payment_method === 'xendit' && <button className="text-button" type="button" disabled={cancellingPayment === transaction.id || checkingPayment === transaction.id} onClick={() => cancelAndSwitchToSavings(transaction)}>{cancellingPayment === transaction.id ? 'Cancelling…' : 'Cancel & switch to savings'}</button>}
          </>}</td>}
        </tr>)}</tbody>
      </table></div>}
      {staff && transactionsPagination && <div className="pagination-controls" aria-label="Payment history pages">
        <button className="button button-outline" type="button" disabled={transactionsPage <= 1 || loading} onClick={() => setTransactionsPage((page) => page - 1)}>{/* BUTTON - previous. */}Previous</button>
        <span>Page {transactionsPage}</span>
        <button className="button button-outline" type="button" disabled={!transactionsPagination.has_more || loading} onClick={() => setTransactionsPage((page) => page + 1)}>{/* BUTTON - next. */}Next</button>
      </div>}
      {!staff && memberTransactionsHaveMore && <div className="load-more-row">
        <button className="button button-outline" type="button" disabled={loadingMoreTransactions || loading} onClick={loadMorePaymentTransactions}>{/* BUTTON - load more transactions. */}
          {loadingMoreTransactions ? 'Loading…' : 'Load more transactions'}
        </button>
      </div>}
    </section>
  )
}

// These lists control which pages staff and members can open from the side menu.
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
  { id: 'terms', label: 'Terms & Conditions', icon: 'terms' },
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
  { id: 'terms', label: 'Terms & Conditions', icon: 'terms' },
]

const STAFF_PAGE_DETAILS = {
  dashboard: ['Dashboard', 'Manage cooperative services and member activity.'],
  learning: ['Cooperative Learning Center', 'Explain membership, share capital, loans, Paluwagan, and balance rules.'],
  'demo-guide': ['Guided Demo Walkthrough', 'Show the main cooperative flow using examples without changing database records.'],
  loans: ['Loans', 'Review loan documents, applications, and available loan offers.'],
  'share-capital': ['Share Capital', 'Track member ownership subscriptions and paid-up contributions.'],
  reports: ['Reports', 'View recorded cooperative totals and monthly activity.'],
  payments: ['Payment Transactions', ''],
  cooperative: ['Daily Paluwagan', 'Members contribute through Xendit checkout. Staff confirm the payout and add it to the recipient’s available balance.'],
  savings: ['Savings', 'Review member balances funded by approved loans and completed Paluwagan payouts.'],
  members: ['Members', ''],
  terms: ['Terms & Conditions', 'Review the account terms and cooperative service guidelines.'],
}

const MEMBER_PAGE_DETAILS = {
  dashboard: ['Dashboard', 'Your cooperative services, all in one place.'],
  learning: ['Cooperative Learning Center', 'Learn how the cooperative and its services work.'],
  'demo-guide': ['Guided Demo Walkthrough', 'Explore the example flow without changing your account records.'],
  loans: ['Loans', 'Review your loan documents, offers, and applications.'],
  'share-capital': ['Share Capital', 'View your ownership subscriptions and paid-up contributions.'],
  payments: ['Payments', 'Pay cooperative dues through Xendit and view transaction history.'],
  cooperative: ['Daily Paluwagan', 'Pay the agreed contribution through Xendit. Once staff confirm the pooled payout, it is added to the recipient’s available balance.'],
  savings: ['Savings', 'View your available balance and transaction history.'],
  terms: ['Terms & Conditions', 'Review the account terms and cooperative service guidelines.'],
}

// This block shows the icon for a staff navigation item.
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
    terms: <><path d="M5 3.5h10l4 4V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" /><path d="M14 3.5V8h5M8 12h8m-8 4h8" /></>,
  }
  return <svg className="staff-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

// This connects the selected menu item to the right member or staff page.
function ServiceDashboard({ token, user, staff, selectedTab, setSelectedTab, refreshKey, paymentInitialPurpose, onSavingsDeposit, resetPaymentPurpose, onBlockedLoanAccess }) {
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
          <span><small>Role</small><strong>{user.role === 'member' && user.member?.is_investor ? 'Member · Investor' : user.role}</strong></span>
        </article>
        {!staff && user.member && <article className="staff-account-card">
          <span className="staff-account-icon"><StaffIcon name="members" /></span>
          <span><small>Member number</small><strong>{user.member.member_number}</strong></span>
        </article>}
      </div>
      {!staff && user.member && <div className="member-dashboard-actions">
        <button className="button button-outline" type="button" onClick={() => setMemberCardOpen(true)}>{/* BUTTON - view / print my member id. */}View / print my member ID</button>
      </div>}
      <nav className="staff-service-tabs" aria-label="Cooperative services">
        {tabs.map((tab) => (
          <button
            className={`staff-service-tab${selectedTab === tab.id ? ' active' : ''}`}
            type="button"
            key={tab.id}
            aria-current={selectedTab === tab.id ? 'page' : undefined}
            onClick={() => {
              if (tab.id === 'loans' && user.role === 'member' && !user.member?.loan_age_eligible) {
                onBlockedLoanAccess()
                return
              }
              if (tab.id === 'payments') resetPaymentPurpose()
              setSelectedTab(tab.id)
            }}
          >{/* BUTTON - opens the selected portal page. */}
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

// This block shows the account terms and conditions.
function TermsAndConditionsDocument() {
  return (
    <article className="terms-document">
      <p className="eyebrow">Effective November 17, 2026 · Version {COOPWISE_TERMS_VERSION}</p>
      <p>These terms explain how to use the CoopWise cooperative-services portal. Please read them before continuing.</p>
      <h3>1. Account and membership information</h3>
      <p>Keep your account credentials private and provide accurate information. Notify cooperative staff if you believe someone accessed your account without permission. Account access may be restricted if your membership or account is inactive.</p>
      <h3>2. Cooperative services</h3>
      <p>Share capital represents ownership in the cooperative and is separate from savings. Loan applications are subject to member eligibility, cooperative policies, available funds, document review, and staff approval. An application or estimate is not a promise of approval. Review the amount, term, repayment schedule, and disclosed charges before submitting.</p>
      <h3>3. Savings, payments, and Paluwagan</h3>
      <p>Review transaction details before confirming a payment. A savings-funded payment deducts the stated amount from the available savings balance. Paluwagan contributions and payouts follow the cycle terms configured by cooperative staff. Report a transaction you believe is incorrect as soon as possible.</p>
      <h3>4. Classroom and online-payment features</h3>
      <p>This CoopWise installation is a school project. Displayed sample balances, transactions, approvals, returns, and payouts are for demonstration and do not represent a bank account or guaranteed real-money transfer. Provider checkout may use test mode. Never submit card, bank, or payment credentials except on the payment provider’s official checkout page.</p>
      <h3>5. Responsible use and support</h3>
      <p>Use the portal only for its intended cooperative services. Do not attempt to access another person’s account, submit false information, or interfere with the system. Contact cooperative staff through the contact method provided by your cooperative if you need help or wish to report a concern.</p>
      <h3>6. Changes and acceptance</h3>
      <p>Cooperative policies and service terms may be updated. If material terms change, you may be asked to review the updated version. Your acceptance is recorded with the account and the version shown above.</p>
      <p>These project terms are informational and do not replace the cooperative’s bylaws, written loan agreement, privacy notice, or advice from a qualified professional.</p>
    </article>
  )
}

// This block asks a new user to accept or decline the terms.
function TermsDecisionDialog({ onAccept, onDecline, saving, error }) {
  const [reachedEnd, setReachedEnd] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const termsRef = useRef(null)

  // This block checks whether the user has reached the bottom of the terms.
  function updateScrollStatus() {
    const element = termsRef.current
    if (element && element.scrollTop + element.clientHeight >= element.scrollHeight - 8) {
      setReachedEnd(true)
    }
  }

  return (
    <div className="record-modal-backdrop terms-modal-backdrop">
      <section className="record-modal terms-modal" role="dialog" aria-modal="true" aria-labelledby="terms-dialog-title">{/* SECTION - shows record-modal. */}
        <div className="record-modal-heading">
          <div><span className="eyebrow">Required for new accounts</span><h2 id="terms-dialog-title">Terms & Conditions</h2></div>
        </div>
        <p>Scroll through the complete terms before you choose whether to continue.</p>
        <div className="terms-scroll" ref={termsRef} onScroll={updateScrollStatus} tabIndex={0} aria-label="Terms and conditions, scroll to the end">
          <TermsAndConditionsDocument />
        </div>
        {!reachedEnd && <p className="notice" role="status">Scroll to the bottom of the terms to enable your choice.</p>}
        {error && <p className="message message-error" role="alert">{error}</p>}
        <label className="terms-accept-checkbox">
          <input type="checkbox" checked={accepted} disabled={!reachedEnd || saving} onChange={(event) => setAccepted(event.target.checked)} />
          <span>I have read and agree to these Terms & Conditions.</span>
        </label>
        <div className="button-row terms-actions">
          {/* SIGN OUT BUTTON - signs out the user. */}
          <button className="button button-outline" type="button" disabled={!reachedEnd || saving} onClick={onDecline}>
            I do not agree — sign out
          </button>
          <button className="button button-primary" type="button" disabled={!reachedEnd || !accepted || saving} onClick={onAccept}>{/* BUTTON - recording acceptance…. */}
            {saving ? 'Recording acceptance…' : 'Agree and continue'}
          </button>
        </div>
      </section>
    </div>
  )
}

// This block shows the staff navigation and selected staff page.
function StaffWorkspace({ token, user, section, setSection, refreshKey, onSignOut, theme, onToggleTheme }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dashboardTab, setDashboardTab] = useState('savings')
  const [paymentInitialPurpose, setPaymentInitialPurpose] = useState('loan')
  const [loanAgeNoticeOpen, setLoanAgeNoticeOpen] = useState(false)
  const staff = ['admin', 'officer'].includes(user.role)
  const navItems = staff ? STAFF_NAV_ITEMS : MEMBER_NAV_ITEMS
  const pageDetails = staff ? STAFF_PAGE_DETAILS : MEMBER_PAGE_DETAILS
  const [pageTitle, pageDescription] = pageDetails[section] || pageDetails.dashboard
  const initials = user.full_name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()

  // This block opens the page selected from the menu.
  function navigate(nextSection) {
    if (nextSection === 'loans' && user.role === 'member' && !user.member?.loan_age_eligible) {
      setLoanAgeNoticeOpen(true)
      setSidebarOpen(false)
      return
    }
    if (nextSection === 'payments') setPaymentInitialPurpose('loan')
    setSection(nextSection)
    setSidebarOpen(false)
  }

  // This block opens the savings deposit form.
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
            >{/* BUTTON - opens the selected staff page. */}
              <StaffIcon name={item.icon} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <button className="staff-sign-out" type="button" onClick={onSignOut}>{/* SIGN OUT BUTTON - signs out the user. */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 17l5-5-5-5m5 5H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></svg>
          <span>Sign out</span>
        </button>
      </aside>
      <div className="staff-main">
        <header className="staff-topbar">
          <button className="staff-menu-toggle" type="button" aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>{/* BUTTON - open navigation. */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="staff-topbar-label">{staff ? 'Cooperative management' : 'Member services'}</span>
          <div className="staff-topbar-actions">
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <span className="staff-role">{user.role}</span>
            <span className="staff-avatar" aria-label={user.full_name}>{initials}</span>
          </div>
        </header>
        <section className={`staff-page-banner${section === 'dashboard' ? '' : ' staff-page-banner-module'}`}>{/* SECTION - shows staff-page-banner. */}
          {section !== 'dashboard' && <span className="staff-page-icon"><StaffIcon name={navItems.find((item) => item.id === section)?.icon || 'dashboard'} /></span>}
          <div className="staff-banner-copy">
            {section === 'dashboard' && <h1>Welcome, {user.full_name} 👋</h1>}
            {section !== 'dashboard' && <h1>{pageTitle}</h1>}
            {pageDescription && <p>{pageDescription}</p>}
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
              onBlockedLoanAccess={() => setLoanAgeNoticeOpen(true)}
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
                      : section === 'terms'
                        ? <TermsAndConditionsDocument />
                        : <ReportsPortal key="reports" token={token} refreshKey={refreshKey} standalone />}
        </div>
      </div>
      {loanAgeNoticeOpen && <div className="record-modal-backdrop">
        <section className="record-modal loan-age-modal" role="dialog" aria-modal="true" aria-labelledby="loan-age-title">{/* SECTION - shows record-modal. */}
          <div className="record-modal-heading"><div><span className="eyebrow">Loan access</span><h2 id="loan-age-title">Not yet eligible for loan services</h2></div></div>
          <p>{user.member?.loan_age === null || user.member?.loan_age === undefined
            ? 'A valid date of birth is required to check loan eligibility. Please contact cooperative staff to review your member profile.'
            : 'CoopWise loan applications and document submissions are available only to members aged 20 or older. You can continue using the other cooperative services available to your account.'}</p>
          <button className="button button-primary" type="button" onClick={() => setLoanAgeNoticeOpen(false)}>{/* BUTTON - close. */}Close</button>
        </section>
      </div>}
    </div>
  )
}

// This is the starting point for sign-in, account setup, and the main dashboard.
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
  const [actionToast, setActionToast] = useState('')
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
  const [acceptingTerms, setAcceptingTerms] = useState(false)
  const [termsError, setTermsError] = useState('')

  useEffect(() => {
    // This block updates the member's investor status after a change.
    function updateMemberInvestorStatus(event) {
      if (typeof event.detail?.is_investor !== 'boolean') return
      setUser((current) => current?.role === 'member' && current.member
        ? { ...current, member: { ...current.member, is_investor: event.detail.is_investor } }
        : current)
    }
    window.addEventListener('coopwise:member-profile-updated', updateMemberInvestorStatus)
    return () => window.removeEventListener('coopwise:member-profile-updated', updateMemberInvestorStatus)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
    window.localStorage.setItem('coopwise_theme', theme)
    window.dispatchEvent(new Event('coopwise:theme-change'))
  }, [theme])

  // This block switches between light and dark mode.
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
    function showActionToast(event) {
      setActionToast(typeof event.detail?.message === 'string' ? event.detail.message : '')
    }
    window.addEventListener('coopwise:action-toast', showActionToast)
    return () => window.removeEventListener('coopwise:action-toast', showActionToast)
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

  // This block saves the sign-in tokens and opens the dashboard.
  function finishSignIn(result) {
    sessionStorage.setItem('coopwise_access_token', result.access_token)
    sessionStorage.setItem('coopwise_refresh_token', result.refresh_token)
    setToken(result.access_token)
    setUser(result.user)
    setSessionError('')
    setSection('dashboard')
  }

  // This block removes saved sign-in data from this browser tab.
  function clearSavedSession() {
    invalidatePortalDataCache()
    sessionStorage.removeItem('coopwise_access_token')
    sessionStorage.removeItem('coopwise_refresh_token')
    setToken(null)
    setUser(null)
    setAuthenticating(false)
    setSessionError('')
    setMode('login')
    setMessage('')
    dispatchActionToast('Your saved session was cleared. Sign in again.')
  }

  // This block changes between sign-in, registration, and password reset.
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
        dispatchActionToast('Registration complete. Sign in with your email or phone number.')
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
        dispatchActionToast(`${result.message} Enter the code if you receive it. It expires in 10 minutes.`)
      } else if (mode === 'reset') {
        const result = await apiRequest('/auth/password-reset/confirm', {
          method: 'POST',
          body: JSON.stringify(values),
        })
        switchAuthMode('login')
        dispatchActionToast(result.message)
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

  async function signOut(skipConfirmation = false) {
    if (!skipConfirmation && !window.confirm('Are you sure you want to sign out?')) return
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
    if (revokeError) {
      setMessage(`Signed out on this device. The server could not revoke the session: ${revokeError}`)
    } else {
      setMessage('')
      dispatchActionToast('You have signed out.')
    }
  }

  async function acceptTerms() {
    if (acceptingTerms) return
    setAcceptingTerms(true)
    setTermsError('')
    try {
      const result = await apiRequest('/auth/terms/accept', {
        token,
        method: 'POST',
        body: JSON.stringify({ terms_version: COOPWISE_TERMS_VERSION }),
      })
      setUser((current) => current
        ? { ...current, terms_required: false, terms_accepted_at: new Date().toISOString() }
        : current)
      dispatchActionToast(result.message)
    } catch (requestError) {
      setTermsError(requestError.message)
    } finally {
      setAcceptingTerms(false)
    }
  }

  if (memberCardToken) return <MemberCardVerification verificationToken={memberCardToken} theme={theme} onToggleTheme={toggleTheme} />

  return (
    <main
      className={`page-shell${user ? ' page-shell-staff' : !memberCardToken ? ' page-shell-auth' : ''}${authenticating && !user ? ' page-shell-auth-loading' : ''}`}
      onKeyDownCapture={enforceNumericKey}
      onPasteCapture={enforceNumericPaste}
      onDropCapture={enforceNumericDrop}
      onBeforeInputCapture={enforceNumericInput}
    >
      <ActionToast message={actionToast} onDismiss={setActionToast} />
      {user ? (
        <>
          <StaffWorkspace token={token} user={user} section={section} setSection={setSection} refreshKey={refreshKey} onSignOut={() => signOut()} theme={theme} onToggleTheme={toggleTheme} />
          {user.terms_required && <TermsDecisionDialog
            onAccept={acceptTerms}
            onDecline={() => signOut(true)}
            saving={acceptingTerms}
            error={termsError}
          />}
        </>
      ) : (
        <>
      {!authenticating && <header className="topbar">
        <a className="brand" href="/" aria-label="CoopWise home">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 27C4 15 11 7 27 5c-1 14-8 22-21 22Z" fill="currentColor" /><path d="M8 27c4-7 9-12 16-17" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" /></svg>
          <span>Coop<span>Wise</span></span>
        </a>
        <div className="topbar-actions">
          <span className="tagline">Cooperative services, made clear</span>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>}

      {authenticating ? (
        <section className="auth-loading" role="status" aria-live="polite">{/* SECTION - shows auth-loading. */}
          <span className="auth-loading-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M4 27C4 15 11 7 27 5c-1 14-8 22-21 22Z" fill="currentColor" /><path d="M8 27c4-7 9-12 16-17" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.5" /></svg>
          </span>
          <span>Loading your CoopWise workspace…</span>
        </section>
      ) : (
        <section className="auth-layout">{/* SECTION - shows auth-layout. */}
          <div className="intro">
            <div className="eyebrow">CoopWise cooperative services</div>
            <h1>Built around your cooperative.</h1>
          </div>

          <div className="card auth-card">
            {sessionError && token && <div className="message message-error" role="alert">
              <p>{sessionError}</p>
              <div className="button-row">
                <button className="text-button" type="button" onClick={() => {
                  setSessionError('')
                  setAuthenticating(true)
                  setSessionAttempt((attempt) => attempt + 1)
                }}>{/* BUTTON - retry session. */}Retry session</button>
                <button className="text-button" type="button" onClick={clearSavedSession}>{/* BUTTON - clear saved session and sign in. */}Clear saved session and sign in</button>
              </div>
            </div>}
            <div className="tabs" role="tablist" aria-label="Account options">
              <button className={mode === 'login' ? 'tab active' : 'tab'} type="button" onClick={() => switchAuthMode('login')}>{/* BUTTON - sign in. */}Sign in</button>
              <button className={mode === 'register' ? 'tab active' : 'tab'} type="button" onClick={() => switchAuthMode('register')}>{/* BUTTON - register. */}Register</button>
            </div>
            <h2>{mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Create your member account' : mode === 'forgot' ? 'Reset your password' : 'Enter your reset code'}</h2>
            {message && <div className="message message-error" role="alert">{message}</div>}
            {authConfigError && <div className="message message-error" role="alert">Sign-in provider settings could not be loaded: {authConfigError}</div>}
            {authConfig?.turnstile_configuration_incomplete && <div className="message message-error" role="alert">The Turnstile site key and secret key both need to be configured before this security check can be used.</div>}
            {turnstileError && <div className="message message-error" role="alert">{turnstileError}</div>}
            <form onSubmit={handleSubmit}>{/* FORM - submits sign-in, registration, or password reset details. */}
              {mode === 'register' ? (
                <div className="form-grid">
                  <label>First name<input name="first_name" autoComplete="given-name" required maxLength="100" onChange={(event) => { event.target.value = event.target.value.replace(/[^\p{L} ]/gu, '').replace(/ {2,}/g, ' ') }} />{fieldErrors.first_name && <small>{fieldErrors.first_name}</small>}</label>
                  <label>Middle name <span className="optional">(optional)</span><input name="middle_name" autoComplete="additional-name" maxLength="100" onChange={(event) => { event.target.value = event.target.value.replace(/[^\p{L} ]/gu, '').replace(/ {2,}/g, ' ') }} />{fieldErrors.middle_name && <small>{fieldErrors.middle_name}</small>}</label>
                  <label>Last name<input name="last_name" autoComplete="family-name" required maxLength="100" onChange={(event) => { event.target.value = event.target.value.replace(/[^\p{L} ]/gu, '').replace(/ {2,}/g, ' ') }} />{fieldErrors.last_name && <small>{fieldErrors.last_name}</small>}</label>
                  <label>Phone number<input name="phone_number" autoComplete="tel" inputMode="numeric" placeholder="09123456789" required pattern="09[0-9]{9}" maxLength="11" onChange={(event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 11) }} />{fieldErrors.phone_number && <small>{fieldErrors.phone_number}</small>}</label>
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
                  <label>Six-digit code<input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" required onChange={(event) => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6) }} /></label>
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
              <button className="button button-primary submit" type="submit" disabled={busy}>{/* BUTTON - send reset code. */}
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
      {!authenticating && <footer aria-hidden="true" />}
        </>
      )}
    </main>
  )
}

export default App
