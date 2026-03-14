const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'

async function request(method, path, body = null, query = {}) {
  const url = new URL(`${API_BASE}${path}`)
  Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v))

  const res = await fetch(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── Video ──────────────────────────────────────────────────────────────────────

export async function getVideoUploadUrl(filename) {
  return request('POST', '/upload-url', null, { filename })
}

export async function uploadFileToS3(presignedUrl, file) {
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'video/mp4' },
    body: file
  })
  if (!res.ok) throw new Error('S3 upload failed')
}

export async function processVideo(s3Key, params) {
  return request('POST', '/process', { s3_key: s3Key, ...params })
}

export async function getJob(jobId) {
  return request('GET', `/job/${jobId}`)
}

export async function listJobs() {
  return request('GET', '/jobs')
}

export async function deleteJob(jobId) {
  return request('DELETE', `/jobs/${jobId}`)
}

// ── Ads ────────────────────────────────────────────────────────────────────────

export async function listAds() {
  return request('GET', '/ads')
}

export async function getAdUploadUrl(filename, contentType) {
  return request('GET', '/ads/upload-url', null, { filename, content_type: contentType })
}

export async function createAd(adData) {
  return request('POST', '/ads', adData)
}

export async function deleteAd(adId) {
  return request('DELETE', `/ads/${adId}`)
}

export async function analyzeAdImage(base64Image, contentType) {
  return request('POST', '/ads/analyze', { image_base64: base64Image, content_type: contentType })
}
