import { useState } from 'react'
import VideoProcessor from './components/VideoProcessor'
import AdManager from './components/AdManager'
import VideoLibrary from './components/VideoLibrary'

const s = {
  app: { minHeight: '100vh', display: 'flex', flexDirection: 'column' },
  header: {
    background: 'linear-gradient(135deg, #1a1f2e 0%, #0d1117 100%)',
    borderBottom: '1px solid #2d3748',
    padding: '0 32px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    height: 64
  },
  logo: { display: 'flex', alignItems: 'center', gap: 10 },
  logoIcon: {
    width: 32, height: 32, borderRadius: 8,
    background: 'linear-gradient(135deg, #667eea, #764ba2)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 16
  },
  logoText: { fontSize: 20, fontWeight: 700, color: '#fff' },
  logoSub: { fontSize: 11, color: '#667eea', fontWeight: 500 },
  badge: {
    background: 'rgba(102,126,234,0.15)', border: '1px solid rgba(102,126,234,0.3)',
    color: '#667eea', borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 500
  },
  tabs: {
    display: 'flex', gap: 0,
    borderBottom: '1px solid #2d3748',
    background: '#0d1117',
    padding: '0 32px'
  },
  tab: (active) => ({
    padding: '16px 24px', cursor: 'pointer', fontSize: 14, fontWeight: 500,
    color: active ? '#667eea' : '#718096',
    borderBottom: active ? '2px solid #667eea' : '2px solid transparent',
    background: 'none', border: 'none', transition: 'all 0.2s'
  }),
  content: { flex: 1, padding: '32px', maxWidth: 1200, margin: '0 auto', width: '100%' }
}

export default function App() {
  const [tab, setTab] = useState('process')

  return (
    <div style={s.app}>
      <header style={s.header}>
        <div style={s.logo}>
          <div style={s.logoIcon}>🎯</div>
          <div>
            <div style={s.logoText}>AdSync</div>
            <div style={s.logoSub}>AI Video Ad Placement</div>
          </div>
        </div>
        <div style={s.badge}>Powered by Amazon Nova</div>
      </header>

      <nav style={s.tabs}>
        <button style={s.tab(tab === 'process')} onClick={() => setTab('process')}>
          🎬 Process Video
        </button>
        <button style={s.tab(tab === 'ads')} onClick={() => setTab('ads')}>
          🏷️ Manage Ads
        </button>
        <button style={s.tab(tab === 'library')} onClick={() => setTab('library')}>
          📚 Video Library
        </button>
      </nav>

      <main style={s.content}>
        {tab === 'process' && <VideoProcessor />}
        {tab === 'ads'     && <AdManager />}
        {tab === 'library' && <VideoLibrary />}
      </main>
    </div>
  )
}
