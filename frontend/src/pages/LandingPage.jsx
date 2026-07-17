import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getStats } from '../lib/api'

/* ── Terminal demos: each chip runs one of these ─────────────────── */
const DEMOS = [
    {
        q: 'what is dependency injection?',
        trace: [
            { text: '  plan      factual query → k=6 · rerank        (llm)', cls: 'plan' },
            { text: '  retrieve  18 candidates · dense + bm25 · rrf-fused', cls: 'dim' },
            { text: '  rerank    cross-encoder · 18 → 6', cls: 'plan' },
            { text: '  grade     evidence sufficient · confidence 0.82', cls: 'ok' },
        ],
        ans: [
            '  FastAPI resolves anything declared with Depends() at',
            '  request time — shared logic defined once, injected',
        ],
        src: '  sources: fastapi_notes.md · di_patterns.md',
    },
    {
        q: 'how does hybrid search work?',
        trace: [
            { text: '  plan      conceptual query → k=8 · rerank      (llm)', cls: 'plan' },
            { text: '  retrieve  24 candidates · dense + bm25 · rrf-fused', cls: 'dim' },
            { text: '  rerank    cross-encoder · 24 → 8', cls: 'plan' },
            { text: '  grade     evidence sufficient · confidence 0.79', cls: 'ok' },
        ],
        ans: [
            '  Dense FAISS vectors catch meaning, BM25 catches exact',
            '  keywords — reciprocal rank fusion merges both rankings.',
        ],
        src: '  sources: dcn_unit2.md · switching_technique.md',
    },
    {
        q: 'explain cosine similarity',
        trace: [
            { text: '  plan      keyword query → k=4 · no rerank      (llm)', cls: 'plan' },
            { text: '  retrieve  12 candidates · dense + bm25 · rrf-fused', cls: 'dim' },
            { text: '  grade     evidence sufficient · confidence 0.91', cls: 'ok' },
        ],
        ans: [
            '  The cosine of the angle between two vectors — 1 means',
            '  identical direction, 0 unrelated. docSeek normalizes',
            '  embeddings so inner product = cosine similarity.',
        ],
        src: '  sources: unit5.md · dcn_unit1.md',
    },
]

const TERM_COLORS = {
    cmd: 'rgba(255,255,255,0.85)',
    plan: '#d97706',
    dim: 'rgba(255,255,255,0.42)',
    ok: '#4ade80',
    ans: 'rgba(255,255,255,0.68)',
}

/* ── Looping, clickable agentic-ask terminal ─────────────────────── */
function Terminal({ demoIdx, onCycle }) {
    const [lines, setLines] = useState([])
    const timers = useRef([])

    const clearTimers = () => {
        timers.current.forEach(clearTimeout)
        timers.current = []
    }
    const later = (fn, ms) => timers.current.push(setTimeout(fn, ms))

    useEffect(() => {
        clearTimers()
        later(() => setLines([]), 0)
        const demo = DEMOS[demoIdx]
        const script = [
            { text: `$ docseek ask "${demo.q}"`, cls: 'cmd', type: true },
            ...demo.trace,
            { text: ' ', cls: 'dim' },
            ...demo.ans.map((t) => ({ text: t, cls: 'ans', type: true })),
            { text: demo.src, cls: 'dim' },
        ]

        let delay = 500
        script.forEach((line, i) => {
            if (line.type) {
                for (let ci = 2; ci <= line.text.length + 1; ci += 2) {
                    const partial = line.text.slice(0, ci)
                    later(() => {
                        setLines((prev) => {
                            const next = prev.slice(0, i)
                            next[i] = { ...line, text: partial }
                            return next
                        })
                    }, delay)
                    delay += 24
                }
                delay += i === 0 ? 500 : 120
            } else {
                later(() => setLines((prev) => { const next = prev.slice(0, i); next[i] = line; return next }), delay)
                delay += 330
            }
        })
        later(onCycle, delay + 5200)

        return clearTimers
    }, [demoIdx, onCycle])

    return (
        <div style={{
            background: '#161513', border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 'var(--radius-xl)', overflow: 'hidden', textAlign: 'left',
            boxShadow: '0 32px 90px rgba(28,25,20,0.35)', width: '100%',
        }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '11px 15px',
                background: '#1d1b18', borderBottom: '1px solid rgba(255,255,255,0.07)',
            }}>
                {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
                    <span key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />
                ))}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.35)', marginLeft: 8 }}>
                    docseek — agentic ask
                </span>
            </div>
            <div style={{
                padding: '18px 22px', minHeight: 232,
                fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.85,
            }}>
                {lines.map((l, i) => l && (
                    <div key={i} style={{ color: TERM_COLORS[l.cls], whiteSpace: 'pre-wrap' }}>{l.text}</div>
                ))}
                <span style={{
                    display: 'inline-block', width: 7, height: 13, background: 'rgba(255,255,255,0.6)',
                    verticalAlign: -2, animation: 'statusPulse 1s ease infinite',
                }} />
            </div>
        </div>
    )
}

/* ── Hero constellation: chunks in vector space, cursor = query ──── */
function Constellation() {
    const canvasRef = useRef(null)

    useEffect(() => {
        const canvas = canvasRef.current
        const hero = canvas.parentElement
        const ctx = canvas.getContext('2d')
        let W, H, nodes = [], raf
        const mouse = { x: -9999, y: -9999 }

        const palette = () => document.documentElement.getAttribute('data-theme') === 'light'
            ? { accent: '180,83,9', dim: '107,95,82' }
            : { accent: '217,119,6', dim: '161,161,170' }

        const resize = () => {
            W = canvas.width = hero.offsetWidth
            H = canvas.height = hero.offsetHeight
            const count = Math.min(64, Math.floor(W * H / 26000))
            nodes = Array.from({ length: count }, () => ({
                x: Math.random() * W, y: Math.random() * H,
                vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
                r: 1.2 + Math.random() * 1.6,
            }))
        }
        const onMove = (e) => {
            const rect = hero.getBoundingClientRect()
            mouse.x = e.clientX - rect.left
            mouse.y = e.clientY - rect.top
        }
        const onLeave = () => { mouse.x = -9999; mouse.y = -9999 }

        const frame = () => {
            ctx.clearRect(0, 0, W, H)
            const { accent, dim } = palette()
            for (const n of nodes) {
                n.x += n.vx; n.y += n.vy
                if (n.x < 0 || n.x > W) n.vx *= -1
                if (n.y < 0 || n.y > H) n.vy *= -1
            }
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i], b = nodes[j]
                    const d = Math.hypot(a.x - b.x, a.y - b.y)
                    if (d < 92) {
                        ctx.strokeStyle = `rgba(${dim},${0.10 * (1 - d / 92)})`
                        ctx.lineWidth = 1
                        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
                    }
                }
            }
            for (const n of nodes) {
                const d = Math.hypot(n.x - mouse.x, n.y - mouse.y)
                if (d < 150) {
                    const s = 1 - d / 150
                    ctx.strokeStyle = `rgba(${accent},${0.35 * s})`
                    ctx.lineWidth = 1.2
                    ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke()
                    ctx.fillStyle = `rgba(${accent},${0.45 + 0.5 * s})`
                    ctx.beginPath(); ctx.arc(n.x, n.y, n.r + s * 1.4, 0, Math.PI * 2); ctx.fill()
                } else {
                    ctx.fillStyle = `rgba(${dim},0.35)`
                    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill()
                }
            }
            raf = requestAnimationFrame(frame)
        }

        resize()
        window.addEventListener('resize', resize)
        hero.addEventListener('mousemove', onMove)
        hero.addEventListener('mouseleave', onLeave)
        raf = requestAnimationFrame(frame)
        return () => {
            cancelAnimationFrame(raf)
            window.removeEventListener('resize', resize)
            hero.removeEventListener('mousemove', onMove)
            hero.removeEventListener('mouseleave', onLeave)
        }
    }, [])

    return (
        <canvas
            ref={canvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.85 }}
        />
    )
}

/* ── Small pieces ────────────────────────────────────────────────── */
function StatChip({ children }) {
    return (
        <span style={{
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 999,
            height: 32, padding: '0 16px', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)',
            color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 8,
        }}>
            {children}
        </span>
    )
}

/* ================================================================== */
export default function LandingPage({ theme, setTheme }) {
    const navigate = useNavigate()
    const [stats, setStats] = useState(null)
    const [demoIdx, setDemoIdx] = useState(0)

    useEffect(() => {
        getStats().then(({ data }) => setStats(data)).catch(() => {})
    }, [])

    const cycle = useCallback(() => setDemoIdx((i) => (i + 1) % DEMOS.length), [])

    return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div className="landing-bloom" />

            {/* NAV */}
            <nav className="navbar anim-nav">
                <div className="nav-logo">
                    <span className="nav-wordmark" style={{ fontFamily: 'var(--font-serif)' }}>doc<span>Seek</span></span>
                </div>
                <div className="nav-right">
                    <a href="https://github.com/K1NGS1LVER/docSeek-modular-document-RAG" target="_blank" rel="noreferrer">
                        <button className="btn-icon" title="GitHub">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                            </svg>
                        </button>
                    </a>
                    <button className="btn-icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
                        {theme === 'dark' ? (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                            </svg>
                        ) : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                            </svg>
                        )}
                    </button>
                    <button className="btn btn-primary" onClick={() => navigate('/app')}>
                        Open docSeek
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                </div>
            </nav>

            {/* HERO — caption left, terminal right */}
            <section style={{
                flex: 1, position: 'relative', display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
                alignItems: 'center', gap: 48, maxWidth: 1184, width: '100%',
                margin: '0 auto', padding: '112px 40px 72px',
            }}>
                <Constellation />

                <div className="anim-1" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <span className="eyebrow">Private · Local · Agentic RAG</span>
                    <h1 style={{
                        fontFamily: 'var(--font-serif)', fontWeight: 400,
                        fontSize: 'clamp(40px, 4.6vw, 60px)', lineHeight: 1.08,
                        letterSpacing: '-0.02em', margin: '24px 0 16px',
                    }}>
                        Ask your documents <em style={{ color: 'var(--accent)' }}>anything.</em>
                    </h1>
                    <p style={{ fontSize: 'var(--fs-lg)', color: 'var(--text-2)', lineHeight: 1.7, maxWidth: 440, marginBottom: 24 }}>
                        Everything runs on your machine — retrieval, reranking, and answers.
                        No clouds. No leaks. Just your library, understood.
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 32 }}>
                        <StatChip>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                            <b style={{ color: 'var(--text-1)' }}>{stats?.total_documents ?? '—'}</b> documents
                        </StatChip>
                        <StatChip><b style={{ color: 'var(--text-1)' }}>{stats?.total_vectors ?? '—'}</b> vectors</StatChip>
                        <StatChip>100% on-device</StatChip>
                    </div>
                    <button className="btn btn-primary btn-lg" onClick={() => navigate('/app')}>
                        Open docSeek
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 32, alignItems: 'center' }}>
                        <span style={{
                            fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '0.14em',
                            color: 'var(--text-3)', textTransform: 'uppercase', width: '100%', marginBottom: 4,
                        }}>
                            Try a question — it runs on the right
                        </span>
                        {DEMOS.map((d, i) => (
                            <button
                                key={i}
                                onClick={() => setDemoIdx(i)}
                                style={{
                                    background: i === demoIdx ? 'var(--accent)' : 'var(--surface)',
                                    border: `1px solid ${i === demoIdx ? 'var(--accent)' : 'var(--border-2)'}`,
                                    color: i === demoIdx ? 'var(--on-accent)' : 'var(--text-2)',
                                    borderRadius: 999, height: 32, padding: '0 16px', fontSize: 'var(--fs-sm)',
                                    fontFamily: 'var(--font-sans)', cursor: 'pointer',
                                    transition: 'all var(--transition)',
                                }}
                            >
                                {d.q.charAt(0).toUpperCase() + d.q.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="anim-3" style={{ position: 'relative' }}>
                    <Terminal demoIdx={demoIdx} onCycle={cycle} />
                </div>
            </section>

            {/* FOOTER */}
            <footer style={{
                padding: '16px 32px', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', flexWrap: 'wrap', gap: 16,
                borderTop: '1px solid var(--border)', position: 'relative',
            }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', letterSpacing: '0.06em' }}>
                    doc<b style={{ color: 'var(--accent)' }}>Seek</b> · local-first RAG
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
                    FastAPI · FAISS · Ollama · sentence-transformers
                </span>
            </footer>
        </div>
    )
}
