import { useState, useEffect, useCallback, useRef } from 'react'
import { listJobs, deleteJob } from '../api'

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function formatDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch { return iso }
}

function parsePlacements(raw) {
  try { return JSON.parse(raw || '[]') } catch { return [] }
}

/* ── Modal ───────────────────────────────────────────────────────────────── */

function Modal({ job, onClose, onDelete }) {
  const overlayRef = useRef(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const placements = parsePlacements(job.placements)

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    try {
      await deleteJob(job.job_id)
      onDelete(job.job_id)
      onClose()
    } catch {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  // close on backdrop click
  const onOverlay = (e) => { if (e.target === overlayRef.current) onClose() }

  // close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // prevent body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const videos = [
    job.output_video     && { label: '✨ Ad Placed',        url: job.output_video,     key: job.output_video_key },
    job.detection_video  && { label: '🎯 Object Detection', url: job.detection_video,  key: job.detection_video_key },
  ].filter(Boolean)

  return (
    <div
      ref={overlayRef}
      onClick={onOverlay}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{
        background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 16,
        width: '100%', maxWidth: 960, maxHeight: '90vh',
        overflow: 'auto', position: 'relative',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)'
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 24px', background: '#0d1117',
          borderBottom: '1px solid #2d3748',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          position: 'sticky', top: 0, zIndex: 1,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{
              fontFamily: 'monospace', fontSize: 14, fontWeight: 700,
              color: '#667eea', background: 'rgba(102,126,234,0.12)',
              border: '1px solid rgba(102,126,234,0.25)',
              padding: '3px 10px', borderRadius: 6
            }}>#{job.job_id}</span>
            <span style={{ fontSize: 13, color: '#718096' }}>{formatDate(job.completed_at)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Delete from modal */}
            {!confirmDelete ? (
              <button
                onClick={handleDelete}
                title="Delete this job"
                style={{
                  padding: '6px 12px', borderRadius: 8, border: '1px solid #3b4a6b',
                  background: 'transparent', color: '#718096', fontSize: 13,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(245,101,101,0.5)'; e.currentTarget.style.color = '#fc8181' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#3b4a6b'; e.currentTarget.style.color = '#718096' }}
              >
                🗑 Delete
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: '#fc8181' }}>Delete this job?</span>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  style={{
                    padding: '6px 14px', borderRadius: 8,
                    border: '1px solid rgba(245,101,101,0.5)',
                    background: 'rgba(245,101,101,0.15)', color: '#fc8181',
                    fontSize: 13, fontWeight: 600, cursor: deleting ? 'default' : 'pointer'
                  }}
                >{deleting ? '...' : 'Yes, delete'}</button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  style={{
                    padding: '6px 14px', borderRadius: 8, border: '1px solid #3b4a6b',
                    background: 'transparent', color: '#a0aec0', fontSize: 13, cursor: 'pointer'
                  }}
                >Cancel</button>
              </div>
            )}

            <button
              onClick={onClose}
              style={{
                background: 'rgba(255,255,255,0.06)', border: '1px solid #3b4a6b',
                color: '#a0aec0', borderRadius: 8, width: 32, height: 32,
                fontSize: 18, cursor: 'pointer', lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}
            >×</button>
          </div>
        </div>

        <div style={{ padding: 24 }}>
          {/* Stats */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            {[
              { val: job.total_placements || 0,                               label: 'Ad Placements' },
              { val: job.frames_processed || 0,                               label: 'Frames w/ Ads' },
              { val: job.frames_total || 0,                                   label: 'Total Frames' },
              { val: `${parseFloat(job.video_duration || 0).toFixed(1)}s`,   label: 'Duration' },
            ].map(({ val, label }) => (
              <div key={label} style={{
                background: 'rgba(102,126,234,0.08)', border: '1px solid rgba(102,126,234,0.15)',
                borderRadius: 10, padding: '10px 18px', minWidth: 100
              }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: '#667eea' }}>{val}</div>
                <div style={{ fontSize: 12, color: '#718096', marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Videos */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: videos.length > 1 ? '1fr 1fr' : '1fr',
            gap: 16, marginBottom: 24
          }}>
            {videos.map(({ label, url }) => (
              <div key={label} style={{
                background: '#0d1117', border: '1px solid #2d3748', borderRadius: 10, overflow: 'hidden'
              }}>
                <div style={{
                  padding: '10px 14px', fontSize: 13, fontWeight: 600, color: '#e2e8f0',
                  background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid #2d3748',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                }}>
                  <span>{label}</span>
                  <a
                    href={url}
                    download
                    style={{
                      padding: '4px 12px', borderRadius: 6,
                      border: '1px solid rgba(102,126,234,0.3)',
                      background: 'rgba(102,126,234,0.08)',
                      color: '#667eea', fontSize: 12, textDecoration: 'none',
                      display: 'flex', alignItems: 'center', gap: 4
                    }}
                  >
                    ⬇ Download
                  </a>
                </div>
                <video controls src={url} style={{ width: '100%', display: 'block', maxHeight: 320 }} />
              </div>
            ))}
          </div>

          {/* Nova Reasoning */}
          {(job.reasoning || job.scene_description) && (
            <div style={{
              marginBottom: 24,
              background: 'linear-gradient(135deg, rgba(102,126,234,0.08), rgba(118,75,162,0.08))',
              border: '1px solid rgba(102,126,234,0.25)',
              borderRadius: 12, padding: 18,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                  background: 'linear-gradient(135deg, #667eea, #764ba2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15
                }}>🧠</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>Nova Pro Reasoning</div>
                  <div style={{ fontSize: 11, color: '#667eea' }}>Why this ad was chosen for this video</div>
                </div>
              </div>
              {job.scene_description && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#718096', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Scene</div>
                  <div style={{ fontSize: 13, color: '#a0aec0', lineHeight: 1.6 }}>{job.scene_description}</div>
                </div>
              )}
              {job.reasoning && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#718096', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Decision</div>
                  <div style={{ fontSize: 14, color: '#e2e8f0', lineHeight: 1.7 }}>{job.reasoning}</div>
                </div>
              )}
            </div>
          )}

          {/* Placement tags — deduplicated by brand + object */}
          {placements.length > 0 && (() => {
            const grouped = {}
            placements.forEach(p => {
              const key = `${p.brand}||${p.target_object}`
              if (!grouped[key]) grouped[key] = { brand: p.brand, target_object: p.target_object, count: 0, confidence: p.confidence || 0 }
              grouped[key].count++
            })
            const unique = Object.values(grouped)
            return (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#a0aec0', marginBottom: 10 }}>
                  Placement Details
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {unique.map((p, i) => (
                    <div key={i} style={{
                      background: 'rgba(102,126,234,0.08)', border: '1px solid rgba(102,126,234,0.2)',
                      borderRadius: 8, padding: '8px 14px', fontSize: 12,
                      display: 'flex', alignItems: 'center', gap: 8
                    }}>
                      <span style={{ fontSize: 18 }}>🏷️</span>
                      <div>
                        <div style={{ color: '#667eea', fontWeight: 700, fontSize: 13 }}>{p.brand}</div>
                        <div style={{ color: '#a0aec0', marginTop: 2 }}>
                          on <span style={{ color: '#e2e8f0' }}>{p.target_object}</span>
                          <span style={{ color: '#4a5568', marginLeft: 8 }}>{p.count} frame{p.count !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

/* ── Grid card ───────────────────────────────────────────────────────────── */

function JobCard({ job, onClick, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const placements = parsePlacements(job.placements)
  const brands = [...new Set(placements.map(p => p.brand).filter(Boolean))]
  const thumb = job.output_video

  const handleDelete = async (e) => {
    e.stopPropagation()
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    try {
      await deleteJob(job.job_id)
      onDelete(job.job_id)
    } catch {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const cancelDelete = (e) => {
    e.stopPropagation()
    setConfirmDelete(false)
  }

  return (
    <div
      onClick={onClick}
      style={{
        background: '#1a1f2e', border: `1px solid ${confirmDelete ? 'rgba(245,101,101,0.5)' : '#2d3748'}`,
        borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
        transition: 'border-color 0.2s, transform 0.15s',
      }}
      onMouseEnter={e => {
        if (!confirmDelete) {
          e.currentTarget.style.borderColor = '#667eea'
          e.currentTarget.style.transform = 'translateY(-2px)'
        }
      }}
      onMouseLeave={e => {
        if (!confirmDelete) {
          e.currentTarget.style.borderColor = '#2d3748'
          e.currentTarget.style.transform = 'translateY(0)'
        }
      }}
    >
      {/* Thumbnail */}
      <div style={{
        position: 'relative', background: '#0d1117',
        aspectRatio: '16/9', overflow: 'hidden'
      }}>
        {thumb ? (
          <video
            src={thumb}
            preload="metadata"
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 36, color: '#2d3748'
          }}>🎬</div>
        )}

        {/* Play overlay */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 50%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: 'rgba(102,126,234,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, paddingLeft: 3,
            boxShadow: '0 4px 16px rgba(102,126,234,0.4)'
          }}>▶</div>
        </div>

        {/* Placement count badge */}
        {(job.total_placements > 0) && (
          <div style={{
            position: 'absolute', top: 10, right: 10,
            background: 'rgba(102,126,234,0.9)',
            color: '#fff', fontSize: 11, fontWeight: 700,
            padding: '3px 8px', borderRadius: 20,
          }}>
            {job.total_placements} placement{job.total_placements !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '12px 14px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 6
        }}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#667eea' }}>
            #{job.job_id}
          </span>
          <span style={{ fontSize: 11, color: '#4a5568' }}>{formatDate(job.completed_at)}</span>
        </div>

        {brands.length > 0 && (
          <div style={{
            fontSize: 13, color: '#e2e8f0', fontWeight: 500,
            marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {brands.join(' · ')}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, fontSize: 11, color: '#718096' }}>
            <span>{parseFloat(job.video_duration || 0).toFixed(1)}s</span>
            <span style={{ color: '#2d3748' }}>·</span>
            <span>{job.frames_processed || 0}/{job.frames_total || 0} frames</span>
            {job.detection_video && (
              <>
                <span style={{ color: '#2d3748' }}>·</span>
                <span style={{ color: '#48bb78' }}>+ detection</span>
              </>
            )}
          </div>

          {/* Delete button / inline confirmation */}
          {!confirmDelete ? (
            <button
              onClick={handleDelete}
              title="Delete video"
              style={{
                padding: '3px 8px', borderRadius: 6, border: '1px solid #3b4a6b',
                background: 'transparent', color: '#718096', fontSize: 12,
                cursor: 'pointer', flexShrink: 0, lineHeight: 1.4
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(245,101,101,0.5)'; e.currentTarget.style.color = '#fc8181' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#3b4a6b'; e.currentTarget.style.color = '#718096' }}
            >
              🗑
            </button>
          ) : (
            <div
              onClick={e => e.stopPropagation()}
              style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
            >
              <span style={{ fontSize: 11, color: '#fc8181', whiteSpace: 'nowrap' }}>Delete?</span>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{
                  padding: '3px 10px', borderRadius: 6,
                  border: '1px solid rgba(245,101,101,0.5)',
                  background: 'rgba(245,101,101,0.15)', color: '#fc8181',
                  fontSize: 11, fontWeight: 600, cursor: deleting ? 'default' : 'pointer'
                }}
              >
                {deleting ? '...' : 'Yes'}
              </button>
              <button
                onClick={cancelDelete}
                style={{
                  padding: '3px 10px', borderRadius: 6,
                  border: '1px solid #3b4a6b',
                  background: 'transparent', color: '#a0aec0',
                  fontSize: 11, cursor: 'pointer'
                }}
              >
                No
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Main component ──────────────────────────────────────────────────────── */

export default function VideoLibrary() {
  const [jobs, setJobs]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [selected, setSelected] = useState(null)

  const handleDeleted = useCallback((jobId) => {
    setJobs(prev => prev.filter(j => j.job_id !== jobId))
    setSelected(s => (s && s.job_id === jobId ? null : s))
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await listJobs()
      setJobs(data.jobs || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const completed = jobs.filter(j => j.status === 'completed' && (j.output_video || j.detection_video))

  return (
    <div>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 24
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>Video Library</div>
          {!loading && (
            <div style={{ fontSize: 13, color: '#4a5568', marginTop: 3 }}>
              {completed.length} processed video{completed.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: '8px 16px', borderRadius: 8, border: '1px solid #3b4a6b',
            background: 'transparent', color: loading ? '#4a5568' : '#a0aec0',
            fontSize: 13, cursor: loading ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 6
          }}
        >
          <span style={{ display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13,
          background: 'rgba(245,101,101,0.1)', border: '1px solid rgba(245,101,101,0.3)',
          color: '#fc8181'
        }}>❌ {error}</div>
      )}

      {loading && !error && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#4a5568' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
          <div>Loading your videos...</div>
        </div>
      )}

      {!loading && completed.length === 0 && !error && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#4a5568' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎬</div>
          <div style={{ fontSize: 15, marginBottom: 8 }}>No processed videos yet</div>
          <div style={{ fontSize: 13 }}>
            Go to <strong style={{ color: '#667eea' }}>Process Video</strong> to get started.
          </div>
        </div>
      )}

      {!loading && completed.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 20
        }}>
          {completed.map(job => (
            <JobCard key={job.job_id} job={job} onClick={() => setSelected(job)} onDelete={handleDeleted} />
          ))}
        </div>
      )}

      {selected && <Modal job={selected} onClose={() => setSelected(null)} onDelete={handleDeleted} />}

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
