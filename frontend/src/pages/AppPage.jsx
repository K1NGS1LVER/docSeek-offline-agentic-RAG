import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'

const API = 'http://localhost:8000'

export default function AppPage({ theme, setTheme }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('upload')
  const [k, setKVal] = useState(5)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [searchTime, setSearchTime] = useState(null)
  const [stats, setStats] = useState(null)
  const [online, setOnline] = useState(null)
  const [docs, setDocs] = useState([])
  const [history, setHistory] = useState(() => JSON.parse(localStorage.getItem('ds_h') || '[]'))
  const [resetConfirm, setResetConfirm] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildMsg, setRebuildMsg] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState(null)
  const [uploadPct, setUploadPct] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteMeta, setPasteMeta] = useState('')
  const [pasting, setPasting] = useState(false)
  const [pasteNote, setPasteNote] = useState(null)
  const [ghUrl, setGhUrl] = useState('')
  const [ghSub, setGhSub] = useState('')
  const [ghLoading, setGhLoading] = useState(false)
  const [ghNote, setGhNote] = useState(null)
  const [ghProgress, setGhProgress] = useState(null)
  const [modal, setModal] = useState(null)
  const [isAskMode, setIsAskMode] = useState(false)
  const [llmResponse, setLlmResponse] = useState('')
  const [asking, setAsking] = useState(false)
  
  const fileRef = useRef(null)
  const searchRef = useRef(null)
  const ghPollRef = useRef(null)

  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch(`${API}/stats`)
      if (!r.ok) throw new Error()
      const d = await r.json()
      setStats(d); setOnline(true)
    } catch { setOnline(false) }
  }, [])

  const fetchDocs = useCallback(async () => {
    try {
      const r = await fetch(`${API}/documents`)
      if (!r.ok) return
      setDocs(await r.json())
    } catch { /* server unreachable; keep last list */ }
  }, [])

  useEffect(() => {
    fetchStats(); fetchDocs()
    const t = setInterval(() => { fetchStats(); fetchDocs() }, 30000)
    return () => clearInterval(t)
  }, [fetchStats, fetchDocs])

  useEffect(() => {
    const h = (e) => {
      if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'k')) && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault(); searchRef.current?.focus()
      }
      if (e.key === 'Escape') { setResults(null); setQuery(''); setModal(null) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  async function handleFiles(files) {
    if (!files || !files.length) return
    setUploading(true); setUploadNote(null); setUploadPct(10)
    try {
      if (files.length === 1) {
        const fd = new FormData(); fd.append('file', files[0])
        setUploadPct(40)
        const r = await fetch(`${API}/upload`, { method: 'POST', body: fd })
        if (!r.ok) throw new Error(await r.text())
        const d = await r.json()
        setUploadPct(100)
        setUploadNote({ type: 'ok', msg: `✓ ${d.filename} — ${d.chunks} chunks in ${d.time_seconds}s` })
      } else {
        const fd = new FormData()
        Array.from(files).forEach(f => fd.append('files', f))
        setUploadPct(40)
        const r = await fetch(`${API}/upload-multiple`, { method: 'POST', body: fd })
        if (!r.ok) throw new Error(await r.text())
        const d = await r.json()
        setUploadPct(100)
        const ok = d.results.filter(x => x.status === 'success').length
        const fail = d.results.filter(x => x.status === 'failed').length
        setUploadNote({ type: 'ok', msg: `✓ ${ok} files, ${d.total_chunks} chunks${fail ? ` · ${fail} failed` : ''}` })
      }
      await fetchStats(); await fetchDocs()
    } catch (e) {
      setUploadNote({ type: 'err', msg: e.message || 'Upload failed' })
    }
    setUploading(false)
    setTimeout(() => setUploadPct(0), 1500)
  }

  async function doPaste() {
    if (!pasteText.trim()) return
    setPasting(true); setPasteNote(null)
    try {
      const r = await fetch(`${API}/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: pasteText.trim(), metadata: pasteMeta.trim() || undefined })
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setPasteNote({ type: 'ok', msg: `✓ Indexed with ID ${d.id}` })
      setPasteText(''); setPasteMeta('')
      await fetchStats(); await fetchDocs()
    } catch (e) { setPasteNote({ type: 'err', msg: e.message || 'Failed' }) }
    setPasting(false)
  }

  async function doGitHub() {
    if (!ghUrl.trim()) return
    setGhLoading(true); setGhNote(null)
    try {
      const r = await fetch(`${API}/ingest/github`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_url: ghUrl.trim(), subpath: ghSub.trim() || undefined })
      })
      if (!r.ok) throw new Error(await r.text())
      setGhNote({ type: 'ok', msg: '✓ Started — tracking progress…' })
      setGhProgress({ msg: 'Starting…', file: '', pct: 0 })
      pollGitHub()
    } catch (e) { setGhNote({ type: 'err', msg: e.message || 'Failed' }) }
    setGhLoading(false)
  }

  function pollGitHub() {
    if (ghPollRef.current) clearInterval(ghPollRef.current)
    ghPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API}/ingest/status`)
        if (!r.ok) return
        const d = await r.json()
        const pct = d.total > 0 ? Math.round((d.progress / d.total) * 100) : 0
        setGhProgress({ msg: d.message || '', file: d.current_file || '', pct })
        if (!d.is_ingesting) {
          clearInterval(ghPollRef.current)
          if (d.error) setGhNote({ type: 'err', msg: `Error: ${d.error}` })
          else setGhNote({ type: 'ok', msg: '✓ Ingestion complete' })
          await fetchStats(); await fetchDocs()
        }
      } catch { /* poll again on next tick */ }
    }, 1500)
  }

  async function doSearch(q) {
    const qry = q || query
    if (!qry.trim()) return
    setSearching(true); setResults(null)
    const t0 = performance.now()
    try {
      const r = await fetch(`${API}/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: qry.trim(), k })
      })
      if (!r.ok) throw new Error(`Server ${r.status}`)
      const data = await r.json()
      setSearchTime(Math.round(performance.now() - t0))
      setResults(data)
      const updated = [qry.trim(), ...history.filter(h => h !== qry.trim())].slice(0, 8)
      setHistory(updated); localStorage.setItem('ds_h', JSON.stringify(updated))
    } catch (e) {
      setResults({ error: e.message.includes('fetch') ? 'Cannot reach server at localhost:8000' : e.message })
    }
    setSearching(false)
  }

  async function doAsk(q) {
    const qry = q || query
    if (!qry.trim()) return
    setAsking(true); setResults(null); setLlmResponse('')
    const t0 = performance.now()
    try {
      const r = await fetch(`${API}/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: qry.trim(), k })
      })
      if (!r.ok) throw new Error(`Server ${r.status}`)
      
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let done = false
      let fullText = ''
      let buffer = '' // Initialize line buffer

      while (!done) {
        const { value, done: doneReading } = await reader.read()
        done = doneReading
        if (value) {
          buffer += decoder.decode(value, { stream: !done })
          const lines = buffer.split('\n')
          buffer = lines.pop() || '' // Retain incomplete line
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                fullText += data
                setLlmResponse(fullText)
              } catch {
                // If the stream data is not JSON (e.g., error string)
                fullText += line.slice(6)
                setLlmResponse(fullText)
              }
            }
          }
        }
      }
      
      // Handle any trailing SSE chunk in the buffer
      if (buffer.startsWith('data: ')) {
        try {
          const data = JSON.parse(buffer.slice(6))
          fullText += data
          setLlmResponse(fullText)
        } catch {
          fullText += buffer.slice(6)
          setLlmResponse(fullText)
        }
      }
      setSearchTime(Math.round(performance.now() - t0))
      const updated = [qry.trim(), ...history.filter(h => h !== qry.trim())].slice(0, 8)
      setHistory(updated); localStorage.setItem('ds_h', JSON.stringify(updated))
    } catch (e) {
      setLlmResponse(`Error: ${e.message.includes('fetch') ? 'Cannot reach server at localhost:8000' : e.message}`)
    }
    setAsking(false)
  }

  async function handleSubmit() {
    if (isAskMode) doAsk()
    else doSearch()
  }

  async function doRebuild() {
    setRebuilding(true); setRebuildMsg('')
    try {
      const r = await fetch(`${API}/rebuild`, { method: 'POST' })
      if (!r.ok) throw new Error()
      const d = await r.json()
      setRebuildMsg(`✓ ${d.documents_indexed} docs`)
      await fetchStats()
    } catch { setRebuildMsg('✗ Failed') }
    setRebuilding(false)
    setTimeout(() => setRebuildMsg(''), 3000)
  }

  async function doReset() {
    setResetting(true)
    try {
      await fetch(`${API}/reset`, { method: 'DELETE' })
      setStats(null); setResults(null); setQuery(''); setDocs([])
      await fetchStats()
    } catch { /* reset failed; leave current state visible */ }
    setResetting(false); setResetConfirm(false)
  }

  function viewDoc(id, start, end) {
    let url = `${API}/document/view?id=${encodeURIComponent(id)}`
    if (start) url += `&start=${start}`
    if (end) url += `&end=${end}`
    window.open(url, '_blank')
  }

  function hl(text, q) {
    if (!q) return esc(text)
    const terms = q.trim().split(/\s+/).filter(t => t.length > 2)
    if (!terms.length) return esc(text)
    let out = esc(text)
    terms.forEach(t => {
      const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
      out = out.replace(re, '<mark style="background:rgba(194,119,58,0.22);color:#c2773a;border-radius:2px;padding:0 2px">$1</mark>')
    })
    return out
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
  function scoreColor(s) { return s >= 0.85 ? '#3a9e6e' : s >= 0.70 ? '#c2773a' : '#514840' }
  function setK(n) { setKVal(n) }

  const hasDocs = stats && (stats.total_documents > 0 || stats.total_vectors > 0)
  const hasResults = results !== null && !searching
  const mono = { fontFamily: "'JetBrains Mono', monospace" }

  const inputStyle = { width: '100%', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 11px', color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', fontSize: 12 }
  const noteStyle = (type) => ({ padding: '5px 9px', borderRadius: 4, ...mono, fontSize: 10, background: type === 'ok' ? 'var(--gs)' : 'var(--rs)', color: type === 'ok' ? 'var(--green)' : 'var(--red)', marginTop: 6 })
  const btnPrimary = (disabled) => ({ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '8px 16px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, fontFamily: 'inherit', width: '100%' })

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)', fontFamily: "'DM Sans', sans-serif" }}>

      {/* TOPBAR */}
      <header style={{ height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => navigate('/')} style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--t2)', background: 'none', cursor: 'pointer' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ width: 30, height: 30, background: 'var(--surface2)', border: '1px solid var(--border2)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)' }}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.4"/><line x1="4" y1="5.5" x2="12" y2="5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><line x1="4" y1="8" x2="9.5" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </div>
            <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-.02em' }}>doc<span style={{ color: 'var(--accent)' }}>Seek</span></span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono, fontSize: 11, color: 'var(--t3)' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: online === null ? 'var(--t3)' : online ? 'var(--green)' : 'var(--red)', animation: online ? 'spulse 2.5s ease infinite' : 'none' }}/>
          <span>{online === null ? 'checking…' : online ? 'connected' : 'offline — localhost:8000'}</span>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={doRebuild} disabled={rebuilding} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 11px', border: '1px solid var(--ambs,rgba(212,160,23,0.13))', borderRadius: 6, color: 'var(--amber,#d4a017)', background: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
            {rebuilding ? <div style={{ width: 12, height: 12, border: '1.5px solid rgba(212,160,23,.3)', borderTopColor: '#d4a017', borderRadius: '50%', animation: 'spin .75s linear infinite' }}/> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>}
            {rebuildMsg || 'Rebuild'}
          </button>
          <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--t2)', background: 'none', cursor: 'pointer' }}>
            {theme === 'dark'
              ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>}
          </button>
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* SIDEBAR */}
        <aside style={{ width: 272, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>

          {/* TABS */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            {['upload', 'paste', 'github'].map(t => (
              <button key={t} onClick={() => setTab(t)}
                style={{ flex: 1, padding: '10px 0', ...mono, fontSize: 10, color: tab === t ? 'var(--accent)' : 'var(--t3)', letterSpacing: '.08em', textTransform: 'uppercase', cursor: 'pointer', background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--accent)' : 'transparent'}`, transition: 'all .15s' }}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {/* UPLOAD TAB */}
          {tab === 'upload' && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
                onClick={() => fileRef.current?.click()}
                style={{ border: `1.5px dashed ${dragging ? 'var(--accent)' : 'var(--border2)'}`, borderRadius: 10, padding: '20px 16px', textAlign: 'center', cursor: 'pointer', background: dragging ? 'var(--as,rgba(194,119,58,0.11))' : 'transparent', transition: 'all .2s' }}
              >
                <input ref={fileRef} type="file" multiple accept=".txt,.md,.markdown,.html,.htm,.docx" style={{ display: 'none' }} onChange={e => { handleFiles(e.target.files); e.target.value = '' }} />
                <div style={{ color: 'var(--t3)', marginBottom: 8, display: 'flex', justifyContent: 'center' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                </div>
                <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 4 }}>Drop files or click to upload</div>
                <div style={{ ...mono, fontSize: 10, color: 'var(--t3)' }}>.txt · .md · .html · .docx</div>
              </div>
              {uploading && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ height: 3, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${uploadPct}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width .3s ease' }}/>
                  </div>
                  <div style={{ ...mono, fontSize: 10, color: 'var(--t3)', marginTop: 4 }}>Uploading…</div>
                </div>
              )}
              {uploadNote && <div style={noteStyle(uploadNote.type)}>{uploadNote.msg}</div>}
            </div>
          )}

          {/* PASTE TAB */}
          {tab === 'paste' && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="Paste text content here…" rows={5}
                  style={{ ...inputStyle, lineHeight: 1.6, resize: 'vertical', minHeight: 80, fontSize: 12.5 }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
                <input value={pasteMeta} onChange={e => setPasteMeta(e.target.value)} placeholder="Source label (optional)"
                  style={{ ...inputStyle, ...mono }}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
                {pasteNote && <div style={noteStyle(pasteNote.type)}>{pasteNote.msg}</div>}
                <button onClick={doPaste} disabled={pasting || !pasteText.trim()} style={btnPrimary(pasting || !pasteText.trim())}>
                  {pasting ? <div style={{ width: 12, height: 12, border: '1.5px solid rgba(255,255,255,.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin .75s linear infinite' }}/> : null}
                  Ingest
                </button>
              </div>
            </div>
          )}

          {/* GITHUB TAB */}
          {tab === 'github' && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <input value={ghUrl} onChange={e => setGhUrl(e.target.value)} placeholder="https://github.com/user/repo"
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
                <input value={ghSub} onChange={e => setGhSub(e.target.value)} placeholder="Subpath (optional)"
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
                {ghNote && <div style={noteStyle(ghNote.type)}>{ghNote.msg}</div>}
                <button onClick={doGitHub} disabled={ghLoading || !ghUrl.trim()} style={btnPrimary(ghLoading || !ghUrl.trim())}>
                  {ghLoading ? <div style={{ width: 12, height: 12, border: '1.5px solid rgba(255,255,255,.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin .75s linear infinite' }}/> : null}
                  Ingest Repo
                </button>
                {ghProgress && (
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginTop: 4 }}>
                    <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 5 }}>{ghProgress.msg}</div>
                    {ghProgress.file && <div style={{ ...mono, fontSize: 10, color: 'var(--t3)', marginBottom: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {ghProgress.file}</div>}
                    <div style={{ height: 3, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${ghProgress.pct}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width .3s' }}/>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* DOCS LIST */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', overflowY: 'auto', flex: 1 }}>
            <div style={{ ...mono, fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              Documents
              <button onClick={fetchDocs} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--t3)', cursor: 'pointer', ...mono, fontSize: 10 }}>↺</button>
            </div>
            {docs.length === 0
              ? <div style={{ ...mono, fontSize: 11, color: 'var(--t3)' }}>No files yet</div>
              : docs.map(f => (
                <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--t3)" strokeWidth="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                  <span style={{ flex: 1, ...mono, fontSize: 11, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</span>
                  <span style={{ ...mono, fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'var(--gs,rgba(58,158,110,0.12))', color: 'var(--green)' }}>✓</span>
                </div>
              ))
            }
          </div>

          {/* STATS */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ ...mono, fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 10 }}>Index</div>
            {[['Documents', stats?.total_documents], ['Vectors', stats?.total_vectors], ['Model', stats?.model?.includes('/') ? stats.model.split('/').pop() : stats?.model], ['Dimensions', stats?.dimension]].map(([lbl, val]) => (
              <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                <span style={{ ...mono, fontSize: 11, color: 'var(--t3)' }}>{lbl}</span>
                <span style={{ ...mono, fontSize: 11, color: 'var(--t2)', fontWeight: 500 }}>{val ?? '—'}</span>
              </div>
            ))}
          </div>

          {/* HISTORY */}
          {history.length > 0 && (
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ ...mono, fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                Recent
                <button onClick={() => { setHistory([]); localStorage.removeItem('ds_h') }} style={{ background: 'none', border: 'none', ...mono, fontSize: 10, color: 'var(--t3)', cursor: 'pointer', padding: 0 }}>clear</button>
              </div>
              {history.slice(0, 5).map((h, i) => (
                <button key={i} onClick={() => { setQuery(h); doSearch(h) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 7px', borderRadius: 4, ...mono, fontSize: 11, color: 'var(--t2)', background: 'none', border: 'none', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'all .12s' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.color = 'var(--t1)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--t2)' }}
                >{h}</button>
              ))}
            </div>
          )}

          {/* RESET */}
          <div style={{ padding: '12px 16px', marginTop: 'auto', flexShrink: 0 }}>
            {!resetConfirm
              ? <button onClick={() => setResetConfirm(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '7px', border: '1px solid var(--rs,rgba(192,57,43,0.12))', borderRadius: 6, color: 'var(--red)', background: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                  Reset Index
                </button>
              : <div>
                  <div style={{ ...mono, fontSize: 11, color: 'var(--red)', marginBottom: 7 }}>Delete all data?</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={doReset} disabled={resetting} style={{ flex: 1, padding: '5px', border: '1px solid var(--rs,rgba(192,57,43,0.12))', borderRadius: 6, color: 'var(--red)', background: 'none', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>{resetting ? '…' : 'Confirm'}</button>
                    <button onClick={() => setResetConfirm(false)} style={{ flex: 1, padding: '5px', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--t2)', background: 'none', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>Cancel</button>
                  </div>
                </div>
            }
            <div style={{ ...mono, fontSize: 10, color: 'var(--t3)', textAlign: 'center', marginTop: 8 }}>/ to search · esc to clear</div>
          </div>
        </aside>

        {/* MAIN */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', background: 'var(--bg)' }}>

          {/* EMPTY */}
          {!hasDocs && !searching && !hasResults && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, color: 'var(--t3)' }}>
              <div style={{ position: 'relative', marginBottom: 18 }}>
                <div style={{ position: 'absolute', inset: -14, borderRadius: '50%', border: '1px solid var(--border)', animation: 'ring 2.8s ease infinite' }}/>
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              </div>
              <div style={{ fontSize: 15, color: 'var(--t2)', fontWeight: 500, marginBottom: 8 }}>No documents indexed</div>
              <p style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.7, textAlign: 'center', maxWidth: 300, marginBottom: 18 }}>Upload files, paste text, or pull from GitHub using the sidebar tabs above.</p>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 14px', ...mono, fontSize: 12, color: 'var(--t2)' }}>
                python -m app.ingest ./docs
              </div>
            </div>
          )}

          {/* READY — centered search */}
          {hasDocs && !hasResults && !searching && !asking && !llmResponse && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <div style={{ width: '100%', maxWidth: 560 }}>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 20 }}>
                  <button onClick={() => setIsAskMode(false)} style={{ padding: '6px 14px', borderRadius: 20, border: `1px solid ${!isAskMode ? 'var(--accent)' : 'var(--border)'}`, background: !isAskMode ? 'var(--as,rgba(194,119,58,0.11))' : 'var(--surface)', color: !isAskMode ? 'var(--accent)' : 'var(--t3)', ...mono, fontSize: 12, cursor: 'pointer', transition: 'all .2s' }}>Search Docs</button>
                  <button onClick={() => setIsAskMode(true)} style={{ padding: '6px 14px', borderRadius: 20, border: `1px solid ${isAskMode ? 'var(--accent)' : 'var(--border)'}`, background: isAskMode ? 'var(--as,rgba(194,119,58,0.11))' : 'var(--surface)', color: isAskMode ? 'var(--accent)' : 'var(--t3)', ...mono, fontSize: 12, cursor: 'pointer', transition: 'all .2s' }}>Ask AI</button>
                </div>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <span style={{ position: 'absolute', left: 14, color: 'var(--t3)', display: 'flex', pointerEvents: 'none' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  </span>
                  <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    placeholder={isAskMode ? "Ask anything about your documents…" : "Search documents…"}
                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '13px 48px 13px 44px', fontSize: 14.5, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit', transition: 'border-color .15s, box-shadow .15s' }}
                    onFocus={e => { e.target.style.borderColor = 'var(--accent)'; e.target.style.boxShadow = '0 0 0 3px var(--as,rgba(194,119,58,0.11))' }}
                    onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none' }}
                  />
                  <span style={{ position: 'absolute', right: 14, ...mono, fontSize: 10, color: 'var(--t3)', pointerEvents: 'none' }}>↵</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, justifyContent: 'center' }}>
                  <span style={{ ...mono, fontSize: 11, color: 'var(--t3)' }}>results:</span>
                  {[3, 5, 10, 20].map(n => (
                    <button key={n} onClick={() => setK(n)} style={{ padding: '3px 10px', borderRadius: 4, border: `1px solid ${k === n ? 'var(--accent)' : 'var(--border)'}`, background: k === n ? 'var(--as,rgba(194,119,58,0.11))' : 'transparent', color: k === n ? 'var(--accent)' : 'var(--t3)', ...mono, fontSize: 11, cursor: 'pointer' }}>{n}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 16, justifyContent: 'center' }}>
                  {['What is dependency injection?', 'How does FAISS index vectors?', 'Explain cosine similarity'].map(sg => (
                    <button key={sg} onClick={() => { setQuery(sg); isAskMode ? doAsk(sg) : doSearch(sg) }}
                      style={{ padding: '5px 13px', borderRadius: 100, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--t1)' }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--t2)' }}
                    >{sg}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* LOADING */}
          {(searching || asking) && (
            <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>
              <div style={{ marginBottom: 20 }}>
                 <span style={{ ...mono, fontSize: 11, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 8 }}>
                   <div style={{ width: 12, height: 12, border: '1.5px solid rgba(194,119,58,.3)', borderTopColor: '#c2773a', borderRadius: '50%', animation: 'spin .75s linear infinite' }}/>
                   {asking ? 'AI is thinking...' : 'Searching...'}
                 </span>
              </div>
              {!asking && [...Array(k)].map((_, i) => (
                <div key={i} style={{ padding: '20px 22px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center' }}>
                    {[20, 110, 36].map((w, j) => <div key={j} style={{ height: j === 1 ? 4 : 8, width: w, borderRadius: j === 1 ? 2 : 4, background: 'var(--surface2)', animation: `shim 1.5s ${j * .1}s ease infinite` }}/>)}
                  </div>
                  {[90, 74, 83].map((w, j) => <div key={j} style={{ height: 8, width: `${w}%`, borderRadius: 4, background: 'var(--surface2)', marginBottom: 7, animation: `shim 1.5s ${j * .1}s ease infinite` }}/>)}
                </div>
              ))}
            </div>
          )}

          {/* RESULTS */}
          {(hasResults || llmResponse) && !(searching && !asking) && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '11px 22px', borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0 }}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <span style={{ position: 'absolute', left: 12, color: 'var(--t3)', display: 'flex', pointerEvents: 'none' }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  </span>
                  <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    placeholder={isAskMode ? "Ask..." : "Search…"}
                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 40px', fontSize: 14, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                  <button onClick={() => { setResults(null); setLlmResponse(''); setQuery('') }} style={{ position: 'absolute', right: 12, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 12 }}>
                  <button onClick={() => setIsAskMode(false)} style={{ padding: '4px 10px', borderRadius: 20, border: `1px solid ${!isAskMode ? 'var(--accent)' : 'var(--border)'}`, background: !isAskMode ? 'var(--as,rgba(194,119,58,0.11))' : 'var(--surface)', color: !isAskMode ? 'var(--accent)' : 'var(--t3)', ...mono, fontSize: 10, cursor: 'pointer', transition: 'all .2s' }}>Search Docs</button>
                  <button onClick={() => setIsAskMode(true)} style={{ padding: '4px 10px', borderRadius: 20, border: `1px solid ${isAskMode ? 'var(--accent)' : 'var(--border)'}`, background: isAskMode ? 'var(--as,rgba(194,119,58,0.11))' : 'var(--surface)', color: isAskMode ? 'var(--accent)' : 'var(--t3)', ...mono, fontSize: 10, cursor: 'pointer', transition: 'all .2s' }}>Ask AI</button>
                </div>
              </div>

              <div style={{ padding: '9px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                <span style={{ ...mono, fontSize: 11, color: 'var(--t3)' }}>
                  {results && results.error ? <span style={{ color: 'var(--red)' }}>{results.error}</span>
                    : llmResponse ? <span style={{ color: 'var(--accent)' }}>AI Response {asking && '...'}</span>
                    : <><span style={{ color: 'var(--t2)' }}>{results?.length || 0}</span> result{results?.length !== 1 ? 's' : ''} · <span style={{ color: 'var(--t2)' }}>{searchTime}ms</span></>}
                </span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ ...mono, fontSize: 10, color: 'var(--t3)', marginRight: 2 }}>k:</span>
                  {[3, 5, 10, 20].map(n => (
                    <button key={n} onClick={() => { setK(n); doSearch() }} style={{ padding: '2px 7px', borderRadius: 3, border: `1px solid ${k === n ? 'var(--accent)' : 'var(--border)'}`, background: k === n ? 'var(--as,rgba(194,119,58,0.11))' : 'transparent', color: k === n ? 'var(--accent)' : 'var(--t3)', ...mono, fontSize: 10, cursor: 'pointer' }}>{n}</button>
                  ))}
                  {Array.isArray(results) && results.length > 0 && (
                    <button onClick={() => { const b = new Blob([JSON.stringify({ query, timestamp: new Date().toISOString(), results }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `docseek-${Date.now()}.json`; a.click() }}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', border: '1px solid var(--border2)', borderRadius: 5, color: 'var(--t2)', background: 'none', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', marginLeft: 6 }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Export
                    </button>
                  )}
                </div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto' }}>
                {llmResponse ? (
                  <div style={{ padding: '24px 32px', color: 'var(--t1)', fontSize: 14.5, lineHeight: 1.8 }} className="llm-response prose prose-invert max-w-none">
                    <ReactMarkdown>{llmResponse}</ReactMarkdown>
                  </div>
                ) : results && results.error ? (
                  <div style={{ margin: '20px 22px', padding: '13px 16px', border: '1px solid var(--rs,rgba(192,57,43,0.12))', background: 'var(--rs,rgba(192,57,43,0.12))', borderRadius: 6 }}>
                    <div style={{ fontSize: 13, color: 'var(--red)', marginBottom: 4 }}>{results.error}</div>
                    <div style={{ ...mono, fontSize: 11, color: 'var(--t3)' }}>uvicorn app.server:app --reload</div>
                  </div>
                ) : results && results.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--t3)', padding: 40 }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <div style={{ fontSize: 14, color: 'var(--t2)' }}>No results found</div>
                  </div>
                ) : results.map((r, i) => (
                  <ResultCard key={r.id} result={r} index={i} query={query} onView={viewDoc} mono={mono} hl={hl} scoreColor={scoreColor} />
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* MODAL (Unused for View Source but kept for other uses) */}
      {modal && (
        <div onClick={() => setModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 14, width: 'min(760px,92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ ...mono, fontSize: 12, color: 'var(--t2)' }}>{modal.title}</span>
              <button onClick={() => setModal(null)} style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', color: 'var(--t2)', cursor: 'pointer' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
              {modal.isHtml
                ? <iframe title="source-view" srcDoc={modal.content} style={{ width: '100%', height: '100%', border: 'none', background: '#0B0B0F' }} />
                : <pre style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--t2)', whiteSpace: 'pre-wrap', wordWrap: 'break-word', ...mono, padding: '20px 22px' }}>{modal.content}</pre>}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.82)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes ring{0%,100%{opacity:.35;transform:scale(1)}50%{opacity:.7;transform:scale(1.04)}}
        @keyframes shim{0%,100%{opacity:.3}50%{opacity:.6}}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
      `}</style>
    </div>
  )
}

function ResultCard({ result, index, query, onView, mono, hl, scoreColor }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = result.content.length > 300
  const sc = scoreColor(result.score)
  const src = result.source
  const fname = src?.filename || src?.raw || ''
  const displayText = !expanded && isLong ? result.content.slice(0, 300) + '…' : result.content

  return (
    <div style={{ padding: '20px 22px', borderBottom: '1px solid var(--border)', borderLeft: '2px solid transparent', transition: 'all .12s' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.borderLeftColor = 'var(--accent)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderLeftColor = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
        <span style={{ ...mono, fontSize: 10, color: 'var(--t3)', minWidth: 22 }}>#{index + 1}</span>
        <div style={{ width: 110, height: 3, background: 'var(--surface2)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.round(result.score * 100)}%`, background: sc, borderRadius: 2 }}/>
        </div>
        <span style={{ ...mono, fontSize: 11, fontWeight: 500, color: sc }}>{result.score.toFixed(4)}</span>
        {fname && <span style={{ ...mono, fontSize: 10, color: 'var(--t3)', marginLeft: 'auto', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fname}</span>}
      </div>
      <p style={{ fontSize: 13.5, lineHeight: 1.75, color: 'var(--t1)', marginBottom: 9 }} dangerouslySetInnerHTML={{ __html: hl(displayText, query) }}/>
      {isLong && (
        <button onClick={() => setExpanded(e => !e)}
          style={{ ...mono, fontSize: 10, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '.05em' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
        >{expanded ? '↑ SHOW LESS' : '↓ SHOW MORE'}</button>
      )}
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...mono, fontSize: 10, color: 'var(--t3)' }}>
        {src?.chunk_index != null && <><span>chunk {src.chunk_index + 1}/{src.total_chunks || '?'}</span><span>·</span></>}
        <span>doc_id: {result.id}</span>
        <span>·</span>
        <span>{result.content.split(/\s+/).length} words</span>
        {src?.source_file && (
          <><span>·</span>
          <span onClick={() => onView(result.id, src.start_char, src.end_char)}
            style={{ color: 'var(--t3)', textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--t3)'}
          >view source ↗</span></>
        )}
      </div>
    </div>
  )
}