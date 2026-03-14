import { useState, useEffect, useRef } from 'react'
import { listAds, getAdUploadUrl, uploadFileToS3, createAd, deleteAd, analyzeAdImage } from '../api'

const CATEGORIES = ['beverage', 'automotive', 'technology', 'coffee', 'sportswear', 'luxury', 'finance', 'outdoor', 'billboard', 'other']

const s = {
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' },
  card: { background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 12, padding: 24 },
  cardTitle: { fontSize: 16, fontWeight: 600, color: '#e2e8f0', marginBottom: 16 },
  label: { fontSize: 13, color: '#a0aec0', marginBottom: 6, display: 'block' },
  input: {
    width: '100%', background: '#0d1117', border: '1px solid #2d3748',
    borderRadius: 8, padding: '10px 12px', color: '#e2e8f0', fontSize: 13,
    marginBottom: 14, outline: 'none'
  },
  select: {
    width: '100%', background: '#0d1117', border: '1px solid #2d3748',
    borderRadius: 8, padding: '10px 12px', color: '#e2e8f0', fontSize: 13,
    marginBottom: 14, outline: 'none', cursor: 'pointer'
  },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  dropzone: (drag, hasFile) => ({
    border: `2px dashed ${drag ? '#667eea' : hasFile ? '#48bb78' : '#3b4a6b'}`,
    borderRadius: 8, padding: '24px 16px', textAlign: 'center',
    cursor: 'pointer', transition: 'all 0.2s', marginBottom: 14,
    background: hasFile ? 'rgba(72,187,120,0.05)' : drag ? 'rgba(102,126,234,0.05)' : 'transparent'
  }),
  btn: (variant = 'primary', disabled = false) => ({
    padding: '11px 20px', borderRadius: 8, border: 'none', fontSize: 13,
    fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled ? '#2d3748'
      : variant === 'primary' ? 'linear-gradient(135deg, #667eea, #764ba2)'
      : variant === 'danger'  ? 'rgba(245,101,101,0.15)'
      : '#2d3748',
    color: disabled ? '#4a5568'
      : variant === 'danger' ? '#fc8181' : '#fff',
    border: variant === 'danger' ? '1px solid rgba(245,101,101,0.3)' : 'none',
    transition: 'all 0.2s', width: variant === 'primary' ? '100%' : 'auto'
  }),
  adGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 },
  adCard: {
    background: '#0d1117', border: '1px solid #2d3748', borderRadius: 10,
    overflow: 'hidden', position: 'relative'
  },
  adImg: { width: '100%', height: 100, objectFit: 'contain', background: '#fff', padding: 8 },
  adInfo: { padding: '10px 12px' },
  adBrand: { fontSize: 13, fontWeight: 600, color: '#e2e8f0' },
  adCat: { fontSize: 11, color: '#667eea', marginTop: 2 },
  adId: { fontSize: 10, color: '#4a5568', marginTop: 4, fontFamily: 'monospace' },
  delBtn: {
    position: 'absolute', top: 6, right: 6, width: 22, height: 22,
    borderRadius: '50%', border: 'none', background: 'rgba(245,101,101,0.8)',
    color: '#fff', fontSize: 12, cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', lineHeight: 1
  },
  empty: { textAlign: 'center', padding: '40px 20px', color: '#4a5568' },
  statusMsg: (ok) => ({
    padding: '10px 14px', borderRadius: 8, fontSize: 12, marginTop: 12,
    background: ok ? 'rgba(72,187,120,0.1)' : 'rgba(245,101,101,0.1)',
    border: `1px solid ${ok ? 'rgba(72,187,120,0.3)' : 'rgba(245,101,101,0.3)'}`,
    color: ok ? '#68d391' : '#fc8181'
  })
}

export default function AdManager() {
  const [ads, setAds]               = useState([])
  const [loading, setLoading]       = useState(true)
  const [logoFile, setLogoFile]     = useState(null)
  const [logoPreview, setLogoPreview] = useState(null)
  const [drag, setDrag]             = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [analyzing, setAnalyzing]   = useState(false)
  const [msg, setMsg]               = useState(null) // { ok, text }
  const [form, setForm]             = useState({
    brand: '', category: 'beverage', ad_type: 'logo',
    keywords: '', description: '', image_description: ''
  })
  const inputRef = useRef(null)

  const fetchAds = async () => {
    try {
      setLoading(true)
      const data = await listAds()
      setAds(data.ads || [])
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAds() }, [])

  const onLogoDrop = async (e) => {
    e.preventDefault(); setDrag(false)
    const f = e.dataTransfer?.files?.[0] || e.target.files?.[0]
    if (!f || !f.type.startsWith('image/')) return

    setLogoFile(f)
    setLogoPreview(URL.createObjectURL(f))

    // Auto-analyze with Nova Pro
    setAnalyzing(true)
    try {
      const reader = new FileReader()
      reader.onload = async (ev) => {
        const base64 = ev.target.result // data:image/...;base64,...
        const result = await analyzeAdImage(base64, f.type)
        setForm(prev => ({
          ...prev,
          brand:             result.brand             || prev.brand,
          category:          result.category          || prev.category,
          ad_type:           result.ad_type           || prev.ad_type,
          keywords:          Array.isArray(result.keywords) ? result.keywords.join(', ') : (result.keywords || prev.keywords),
          description:       result.description       || prev.description,
          image_description: result.image_description || prev.image_description,
        }))
        setAnalyzing(false)
      }
      reader.readAsDataURL(f)
    } catch {
      setAnalyzing(false)
    }
  }

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async () => {
    if (!form.brand || !form.category || !logoFile) {
      setMsg({ ok: false, text: 'Brand, category and logo image are required.' }); return
    }
    setSubmitting(true); setMsg(null)
    try {
      const { upload_url, s3_key } = await getAdUploadUrl(logoFile.name, logoFile.type)
      await uploadFileToS3(upload_url, logoFile)
      await createAd({
        ...form,
        keywords: form.keywords.split(',').map(k => k.trim()).filter(Boolean),
        asset_s3_key: s3_key
      })
      setMsg({ ok: true, text: `✅ "${form.brand}" ad created successfully!` })
      setForm({ brand: '', category: 'beverage', ad_type: 'logo', keywords: '', description: '', image_description: '' })
      setLogoFile(null)
      setLogoPreview(null)
      fetchAds()
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (adId, brand) => {
    if (!confirm(`Delete "${brand}"?`)) return
    try {
      await deleteAd(adId)
      setAds(a => a.filter(x => x.ad_id !== adId))
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    }
  }

  return (
    <div style={s.grid}>
      {/* Upload new ad */}
      <div style={s.card}>
        <div style={s.cardTitle}>➕ Upload New Ad</div>

        <div style={s.row}>
          <div>
            <label style={s.label}>Brand Name *</label>
            <input style={s.input} placeholder="e.g. Nike" value={form.brand} onChange={set('brand')} />
          </div>
          <div>
            <label style={s.label}>Category *</label>
            <select style={s.select} value={form.category} onChange={set('category')}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={s.row}>
          <div>
            <label style={s.label}>Ad Type</label>
            <select style={s.select} value={form.ad_type} onChange={set('ad_type')}>
              <option value="logo">Logo</option>
              <option value="poster">Poster</option>
            </select>
          </div>
          <div>
            <label style={s.label}>Keywords (comma separated)</label>
            <input style={s.input} placeholder="shoe, sneaker, sport" value={form.keywords} onChange={set('keywords')} />
          </div>
        </div>

        <label style={s.label}>Description</label>
        <input style={s.input} placeholder="Brief ad description" value={form.description} onChange={set('description')} />

        <label style={s.label}>Image Description (helps AI place the logo)</label>
        <input style={s.input} placeholder="e.g. Nike swoosh — white tick on black background"
          value={form.image_description} onChange={set('image_description')} />

        <label style={s.label}>Logo Image *</label>
        <div
          style={s.dropzone(drag, !!logoFile)}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={onLogoDrop}
        >
          {logoPreview
            ? <div style={{ position: 'relative' }}>
                <img src={logoPreview} alt="preview"
                  style={{ maxHeight: 120, maxWidth: '100%', objectFit: 'contain', borderRadius: 6, marginBottom: 8 }} />
                {analyzing
                  ? <div style={{ fontSize: 12, color: '#667eea', marginTop: 4 }}>✨ Analyzing with Nova Pro...</div>
                  : <div style={{ fontSize: 11, color: '#4a5568', marginTop: 4 }}>{logoFile.name} · Click to change</div>}
              </div>
            : <><div style={{ fontSize: 28, marginBottom: 6 }}>🖼️</div>
                <div style={{ fontSize: 13, color: '#a0aec0' }}>Drop logo image or click to browse</div>
                <div style={{ fontSize: 11, color: '#4a5568', marginTop: 4 }}>PNG, JPG, SVG</div></>}
          <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onLogoDrop} />
        </div>

        <button style={s.btn('primary', submitting)} onClick={handleSubmit} disabled={submitting}>
          {submitting ? '⏳ Uploading...' : '➕ Add Ad'}
        </button>

        {msg && <div style={s.statusMsg(msg.ok)}>{msg.text}</div>}
      </div>

      {/* Ad catalog */}
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={s.cardTitle}>🗂️ Ad Catalog ({ads.length})</div>
          <button onClick={fetchAds} style={{ ...s.btn('secondary'), padding: '6px 12px', fontSize: 12 }}>
            🔄 Refresh
          </button>
        </div>

        {loading
          ? <div style={s.empty}>Loading ads...</div>
          : ads.length === 0
            ? <div style={s.empty}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                No ads yet. Upload your first ad.
              </div>
            : <div style={s.adGrid}>
                {ads.map(ad => (
                  <div key={ad.ad_id} style={s.adCard}>
                    <button style={s.delBtn} onClick={() => handleDelete(ad.ad_id, ad.brand)} title="Delete">✕</button>
                    <div style={s.adImg}>
                      <img
                        src={ad.image_url || ''}
                        alt={ad.brand}
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        onError={(e) => { e.target.style.display = 'none' }}
                      />
                    </div>
                    <div style={s.adInfo}>
                      <div style={s.adBrand}>{ad.brand}</div>
                      <div style={s.adCat}>{ad.category} · {ad.ad_type}</div>
                      <div style={s.adId}>{ad.ad_id}</div>
                    </div>
                  </div>
                ))}
              </div>}
      </div>
    </div>
  )
}
