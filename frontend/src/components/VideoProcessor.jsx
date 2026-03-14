import { useState, useRef, useCallback, useEffect } from 'react'
import { getVideoUploadUrl, uploadFileToS3, processVideo, getJob } from '../api'

const POLL_INTERVAL = 8000

const s = {
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 },
  card: {
    background: '#1a1f2e', border: '1px solid #2d3748',
    borderRadius: 12, padding: 24
  },
  cardTitle: { fontSize: 16, fontWeight: 600, color: '#e2e8f0', marginBottom: 16 },
  dropzone: (drag) => ({
    border: `2px dashed ${drag ? '#667eea' : '#3b4a6b'}`,
    borderRadius: 10, padding: '40px 20px', textAlign: 'center',
    cursor: 'pointer', transition: 'all 0.2s',
    background: drag ? 'rgba(102,126,234,0.05)' : 'transparent'
  }),
  dropIcon: { fontSize: 40, marginBottom: 12 },
  dropText: { color: '#a0aec0', fontSize: 14 },
  dropHint: { color: '#4a5568', fontSize: 12, marginTop: 6 },
  fileInfo: {
    display: 'flex', alignItems: 'center', gap: 12,
    background: 'rgba(102,126,234,0.1)', border: '1px solid rgba(102,126,234,0.2)',
    borderRadius: 8, padding: '12px 16px', marginTop: 12
  },
  fileName: { fontSize: 13, color: '#e2e8f0', fontWeight: 500 },
  fileSize: { fontSize: 12, color: '#718096' },
  btn: (disabled) => ({
    width: '100%', padding: '14px', borderRadius: 8, border: 'none',
    fontSize: 15, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled
      ? 'linear-gradient(135deg, #2d3748, #2d3748)'
      : 'linear-gradient(135deg, #667eea, #764ba2)',
    color: disabled ? '#4a5568' : '#fff',
    transition: 'all 0.2s', marginTop: 8
  }),
  status: (type) => ({
    padding: '12px 16px', borderRadius: 8, fontSize: 13, marginTop: 16,
    background: type === 'error' ? 'rgba(245,101,101,0.1)' : 'rgba(102,126,234,0.1)',
    border: `1px solid ${type === 'error' ? 'rgba(245,101,101,0.3)' : 'rgba(102,126,234,0.3)'}`,
    color: type === 'error' ? '#fc8181' : '#a0aec0'
  }),
  progress: {
    width: '100%', height: 4, background: '#2d3748',
    borderRadius: 2, overflow: 'hidden', marginTop: 8
  },
  progressBar: (pct) => ({
    height: '100%', width: `${pct}%`,
    background: 'linear-gradient(90deg, #667eea, #764ba2)',
    transition: 'width 0.5s ease', borderRadius: 2
  }),
  results: { marginTop: 24 },
  resultsTitle: { fontSize: 16, fontWeight: 600, marginBottom: 16, color: '#e2e8f0' },
  videoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  videoCard: { background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 10, overflow: 'hidden' },
  videoLabel: {
    padding: '10px 14px', fontSize: 13, fontWeight: 600,
    background: '#0d1117', borderBottom: '1px solid #2d3748',
    display: 'flex', alignItems: 'center', gap: 6
  },
  video: { width: '100%', display: 'block' },
  statsRow: { display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  stat: {
    background: 'rgba(102,126,234,0.1)', border: '1px solid rgba(102,126,234,0.2)',
    borderRadius: 8, padding: '8px 14px', fontSize: 12
  },
  statVal: { fontSize: 18, fontWeight: 700, color: '#667eea', display: 'block' },
  statLabel: { color: '#718096' },
  // number input shared style
  numInput: {
    width: 72, padding: '7px 10px', textAlign: 'center',
    background: '#0d1117', border: '1px solid #3b4a6b',
    borderRadius: 8, color: '#e2e8f0', fontSize: 16, fontWeight: 700,
    outline: 'none', MozAppearance: 'textfield',
  },
}

/* ── Detect video metadata (duration + FPS) from a blob URL ─────────────── */
function useVideoMeta(localVideoUrl, onFps, onDuration) {
  // Store callbacks in refs so they never appear in the effect deps array.
  // This means the effect only re-runs when the video URL itself changes —
  // NOT when the parent re-renders because the user edited a field.
  const onFpsRef      = useRef(onFps)
  const onDurationRef = useRef(onDuration)
  onFpsRef.current      = onFps
  onDurationRef.current = onDuration

  useEffect(() => {
    if (!localVideoUrl) return
    const video = document.createElement('video')
    video.src = localVideoUrl
    video.muted = true
    video.playsInline = true

    let cancelled = false
    let frameCount = 0
    let firstMediaTime = null

    const onMeta = () => {
      if (cancelled) return
      if (video.duration && isFinite(video.duration)) {
        onDurationRef.current(Math.round(video.duration))
      }

      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        const tick = (_now, meta) => {
          if (cancelled) { video.pause(); return }
          if (firstMediaTime === null) firstMediaTime = meta.mediaTime
          frameCount++
          const elapsed = meta.mediaTime - firstMediaTime
          if (frameCount >= 6 && elapsed > 0) {
            const raw = frameCount / elapsed
            const common = [15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]
            const snapped = common.reduce((a, b) =>
              Math.abs(b - raw) < Math.abs(a - raw) ? b : a
            )
            onFpsRef.current(Math.round(snapped))
            video.pause()
          } else {
            video.requestVideoFrameCallback(tick)
          }
        }
        video.requestVideoFrameCallback(tick)
        video.play().catch(() => { if (!cancelled) onFpsRef.current(24) })
      } else {
        onFpsRef.current(24)
      }
    }

    video.addEventListener('loadedmetadata', onMeta)
    video.load()

    return () => {
      cancelled = true
      video.pause()
      video.removeEventListener('loadedmetadata', onMeta)
      video.src = ''
    }
  }, [localVideoUrl]) // ← only the URL; callbacks are accessed via refs
}

/* ── Labelled number + range row ─────────────────────────────────────────── */
function SettingRow({ label, hint, value, onChange, min, max, unit }) {
  const clamp = (v) => {
    const n = parseFloat(v)
    if (isNaN(n)) return value
    return Math.max(min, n)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline',
        justifyContent: 'space-between', marginBottom: 10
      }}>
        <span style={{ fontSize: 13, color: '#a0aec0' }}>{label}</span>
        {hint && <span style={{ fontSize: 11, color: '#48bb78' }}>{hint}</span>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Editable number input */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <input
            type="number"
            value={value}
            min={min}
            onChange={e => onChange(clamp(e.target.value))}
            onBlur={e => onChange(clamp(e.target.value))}
            style={s.numInput}
          />
          <span style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            fontSize: 10, color: '#4a5568', pointerEvents: 'none'
          }}>{unit}</span>
        </div>

        {/* Slider */}
        <input
          type="range"
          min={min}
          max={max}
          step={unit === 'fps' ? 1 : 1}
          value={Math.min(value, max)}
          onChange={e => onChange(+e.target.value)}
          style={{ flex: 1, accentColor: '#667eea', cursor: 'pointer' }}
        />
      </div>
    </div>
  )
}

/* ── Main component ──────────────────────────────────────────────────────── */
export default function VideoProcessor() {
  const [file, setFile]             = useState(null)
  const [localVideoUrl, setLocalVideoUrl] = useState(null)
  const [drag, setDrag]             = useState(false)
  const [fps, setFps]               = useState(24)
  const [seconds, setSeconds]       = useState(10)
  const [videoDuration, setVideoDuration] = useState(null) // actual video length
  const [stage, setStage]           = useState('idle')
  const [progress, setProgress]     = useState(0)
  const [statusMsg, setStatusMsg]   = useState('')
  const [result, setResult]         = useState(null)
  const [error, setError]           = useState('')
  const [reasoning, setReasoning]   = useState(null)  // Nova's explanation, arrives mid-job
  const pollRef                     = useRef(null)
  const inputRef                    = useRef(null)

  // Track actual duration separately to use as slider max
  const setSecondsAndDuration = useCallback((val) => {
    setSeconds(val)
    setVideoDuration(v => v === null ? val : v) // set only first time
  }, [])

  // Auto-detect FPS + duration when a video is picked
  useVideoMeta(localVideoUrl, setFps, (dur) => {
    setSeconds(dur)
    setVideoDuration(dur)
  })

  // Revoke object URL on unmount / change
  useEffect(() => {
    return () => { if (localVideoUrl) URL.revokeObjectURL(localVideoUrl) }
  }, [localVideoUrl])

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDrag(false)
    const f = e.dataTransfer?.files?.[0] || e.target.files?.[0]
    if (f && f.type.startsWith('video/')) {
      setFile(f)
      setLocalVideoUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f) })
    }
  }, [])

  const poll = useCallback((jobId) => {
    pollRef.current = setInterval(async () => {
      try {
        const data = await getJob(jobId)
        if (data.status === 'completed') {
          clearInterval(pollRef.current)
          setStage('done'); setResult(data); setProgress(100)
          if (data.reasoning) setReasoning({ reasoning: data.reasoning, scene_description: data.scene_description })
        } else if (data.status === 'error') {
          clearInterval(pollRef.current)
          setStage('error'); setError(data.error || 'Processing failed')
        } else {
          setProgress(p => Math.min(p + 5, 90))
          // Show reasoning as soon as Nova Pro finishes (step 3), even while frames process
          if (data.reasoning && !reasoning) {
            setReasoning({ reasoning: data.reasoning, scene_description: data.scene_description })
            setStatusMsg('Nova chose a placement — processing frames...')
          } else {
            setStatusMsg('Processing frames with Amazon Nova...')
          }
        }
      } catch { /* keep polling */ }
    }, POLL_INTERVAL)
  }, [])

  const handleSubmit = async () => {
    if (!file) return
    setStage('uploading'); setProgress(0); setError(''); setResult(null)
    try {
      setStatusMsg('Getting upload URL...'); setProgress(10)
      const { upload_url, s3_key } = await getVideoUploadUrl(file.name)

      setStatusMsg('Uploading video to S3...'); setProgress(25)
      await uploadFileToS3(upload_url, file)

      setStatusMsg('Queuing job...'); setProgress(35)
      const { job_id } = await processVideo(s3_key, { fps, max_seconds: seconds })

      setStage('processing')
      setStatusMsg('Amazon Nova is analyzing your video...'); setProgress(40)
      poll(job_id)
    } catch (e) {
      setStage('error'); setError(e.message)
    }
  }

  const reset = () => {
    clearInterval(pollRef.current)
    setFile(null)
    if (localVideoUrl) { URL.revokeObjectURL(localVideoUrl); setLocalVideoUrl(null) }
    setStage('idle'); setProgress(0)
    setResult(null); setError(''); setStatusMsg(''); setReasoning(null)
    setFps(24); setSeconds(10); setVideoDuration(null)
  }

  const formatSize = (bytes) => bytes > 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : `${(bytes / 1e3).toFixed(0)} KB`

  const busy = stage === 'uploading' || stage === 'processing'
  const sliderMaxSec = videoDuration ? Math.max(videoDuration, seconds) : Math.max(seconds, 60)

  return (
    <div>
      <div style={s.grid}>
        {/* ── Upload ── */}
        <div style={s.card}>
          <div style={s.cardTitle}>📤 Upload Video</div>

          {!file ? (
            <div
              style={s.dropzone(drag)}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
            >
              <div style={s.dropIcon}>🎬</div>
              <div style={s.dropText}>Drop a video here or click to browse</div>
              <div style={s.dropHint}>MP4, MOV, AVI — max 500MB</div>
            </div>
          ) : (
            <div>
              <video
                key={localVideoUrl}
                src={localVideoUrl}
                controls
                style={{ width: '100%', borderRadius: 8, display: 'block', background: '#000', maxHeight: 280 }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <div style={{ ...s.fileInfo, flex: 1, margin: 0 }}>
                  <span style={{ fontSize: 20 }}>🎥</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ ...s.fileName, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                    <div style={s.fileSize}>{formatSize(file.size)}</div>
                  </div>
                </div>
                <button onClick={reset} style={{
                  padding: '8px 14px', borderRadius: 8, border: '1px solid #3b4a6b',
                  background: 'transparent', color: '#a0aec0', fontSize: 13,
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0
                }}>✕ Cancel</button>
                <button onClick={() => inputRef.current?.click()} style={{
                  padding: '8px 14px', borderRadius: 8, border: '1px solid #3b4a6b',
                  background: 'transparent', color: '#a0aec0', fontSize: 13,
                  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0
                }}>Change</button>
              </div>
            </div>
          )}
          <input ref={inputRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={onDrop} />
        </div>

        {/* ── Settings ── */}
        <div style={s.card}>
          <div style={s.cardTitle}>⚙️ Processing Settings</div>

          <SettingRow
            label="Frames per Second"
            hint={localVideoUrl ? '← detected from video' : undefined}
            value={fps}
            min={1}
            max={120}
            unit="fps"
            onChange={setFps}
          />

          <SettingRow
            label="Duration to Process"
            hint={videoDuration ? `← full video: ${Math.round(videoDuration)}s` : undefined}
            value={seconds}
            min={1}
            max={sliderMaxSec}
            unit="sec"
            onChange={setSeconds}
          />

          <div style={{
            background: 'rgba(102,126,234,0.05)', border: '1px solid rgba(102,126,234,0.15)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#718096'
          }}>
            Estimated frames: <strong style={{ color: '#667eea' }}>{fps * seconds}</strong>
            &nbsp;· Processing time: ~<strong style={{ color: '#667eea' }}>{Math.round(fps * seconds * 0.5)} min</strong>
          </div>

          <button style={s.btn(!file || busy)} onClick={handleSubmit} disabled={!file || busy}>
            {busy ? '⏳ Processing...' : '🚀 Start Processing'}
          </button>

          {stage !== 'idle' && (
            <div style={s.status(stage === 'error' ? 'error' : 'info')}>
              {stage === 'error' ? `❌ ${error}` : `⚡ ${statusMsg}`}
              {busy && (
                <div style={s.progress}>
                  <div style={s.progressBar(progress)} />
                </div>
              )}
            </div>
          )}

          {stage === 'done' && (
            <button onClick={reset} style={{
              ...s.btn(false), marginTop: 8,
              background: 'transparent', border: '1px solid #3b4a6b', color: '#a0aec0'
            }}>
              Process Another Video
            </button>
          )}
        </div>
      </div>

      {/* ── Nova Reasoning ── */}
      {reasoning && (
        <div style={{
          marginTop: 24,
          background: 'linear-gradient(135deg, rgba(102,126,234,0.08), rgba(118,75,162,0.08))',
          border: '1px solid rgba(102,126,234,0.25)',
          borderRadius: 12, padding: 20,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: 'linear-gradient(135deg, #667eea, #764ba2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0
            }}>🧠</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>Nova Pro Reasoning</div>
              <div style={{ fontSize: 12, color: '#667eea' }}>Why this ad was chosen</div>
            </div>
            {stage === 'processing' && (
              <span style={{
                marginLeft: 'auto', fontSize: 11, color: '#48bb78',
                background: 'rgba(72,187,120,0.1)', border: '1px solid rgba(72,187,120,0.25)',
                padding: '3px 10px', borderRadius: 20
              }}>✓ Analysis complete</span>
            )}
          </div>

          {reasoning.scene_description && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#718096', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Scene</div>
              <div style={{ fontSize: 13, color: '#a0aec0', lineHeight: 1.6 }}>{reasoning.scene_description}</div>
            </div>
          )}

          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#718096', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Decision</div>
            <div style={{ fontSize: 14, color: '#e2e8f0', lineHeight: 1.7 }}>{reasoning.reasoning}</div>
          </div>
        </div>
      )}

      {/* ── Results ── */}
      {result && (
        <div style={s.results}>
          <div style={s.resultsTitle}>✅ Processing Complete</div>
          <div style={s.statsRow}>
            {[
              { val: result.total_placements || 0,                              label: 'Ad Placements' },
              { val: result.frames_processed || 0,                              label: 'Frames Processed' },
              { val: result.frames_total || 0,                                  label: 'Total Frames' },
              { val: `${parseFloat(result.video_duration || 0).toFixed(1)}s`,  label: 'Video Duration' },
            ].map(({ val, label }) => (
              <div key={label} style={s.stat}>
                <span style={s.statVal}>{val}</span>
                <span style={s.statLabel}>{label}</span>
              </div>
            ))}
          </div>

          <div style={s.videoGrid}>
            {result.detection_video && (
              <div style={s.videoCard}>
                <div style={s.videoLabel}><span>🎯</span> Object Detection</div>
                <video controls style={s.video} src={result.detection_video} />
              </div>
            )}
            {result.output_video && (
              <div style={s.videoCard}>
                <div style={s.videoLabel}><span>✨</span> Ad Placed</div>
                <video controls style={s.video} src={result.output_video} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Hide number input spinners in WebKit */}
      <style>{`
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { opacity: 1; }
      `}</style>
    </div>
  )
}
