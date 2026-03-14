# AdSync

Product placement is one of the most effective forms of advertising — a brand logo naturally appearing on a surface within a scene, blending into the content rather than interrupting it. Traditionally, this requires months of negotiation, script rewrites, and costly reshoots. It's a format that only large studios and big-budget productions can afford.

Independent creators — YouTubers, TikTokers, Instagram videographers — produce millions of hours of content every year with no way to access this format. They're locked out not because their content isn't valuable, but because the process is too expensive and manual.

**AdSync automates product placement using AI.** Upload any video and a brand logo, and AdSync finds the most contextually appropriate surface, places the ad with realistic perspective and lighting, and blends it seamlessly into the scene — in minutes, with no manual editing.

---

## Demo

| Original | Object Detected | Ad Placed |
|:---:|:---:|:---:|
| <video src="https://github.com/goalhunter/adsync/raw/main/demo/4411615-uhd_3840_2160_30fps.mp4" width="260" controls></video> | <video src="https://github.com/goalhunter/adsync/raw/main/demo/a65fdcea_detection.mp4" width="260" controls></video> | <video src="https://github.com/goalhunter/adsync/raw/main/demo/a65fdcea_adplaced.mp4" width="260" controls></video> |

---

## How It Works

### 1. Add a Brand
Drop in a logo. **Amazon Nova Pro** instantly analyzes the image and auto-fills the brand name, category, keywords, and visual description. Everything's editable before saving. The brand is now in the catalog, ready to be placed.

### 2. Upload a Video
Upload any video — a camping clip, a cooking reel, a product review. AdSync will find the opportunity inside it.

### 3. Scene Understanding — Nova Pro
Sample frames are sent to **Amazon Nova Pro**, which acts as an advertising strategist. It scans every visible surface, scores each on contextual fit, stability, visibility, and position, then picks the single most believable (surface + ad) combination and explains its reasoning. A Starbucks logo on a coffee cup beats a Starbucks logo on a soda can. Quality of placement always beats size.

### 4. Object Detection — Rekognition + YOLO World
Once Nova Pro decides *what* to target, **Amazon Rekognition** finds that object precisely in every frame with bounding-box accuracy. Nova Pro maps its target description to the closest Rekognition label. If Rekognition cannot confidently match the target, **YOLO World** — an open-vocabulary detection model — is used as a fallback, running the same prompt directly against each frame.

### 5. Ad Overlay — Perspective Warp + Ambient Lighting
The logo is placed on the detected surface in each frame. If the surface has a detectable geometric shape, a **perspective warp** is applied so the logo follows the surface naturally. The logo also picks up the scene's ambient color cast — so it doesn't look pasted on.

### 6. Edge Blending — Nova Canvas
**Amazon Nova Canvas** inpaints the ring of pixels surrounding the logo, seamlessly blending it into the scene's lighting, shadows, and texture. The result looks like the logo was printed onto the surface, not composited in post.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + Tailwind |
| Backend | Python, AWS Lambda |
| AI | Amazon Nova Pro, Nova Canvas, Rekognition |
| Storage | S3 + DynamoDB |
| Infra | AWS CDK |

---

## Project Structure

```
backend/     # Lambda processing pipeline (scene analysis, detection, frame manipulation)
frontend/    # React app (upload, job polling, video playback)
demo/        # Sample videos: original, detection, ad-placed
```

---

## Usage

### Frontend
```bash
cd frontend
npm install
npm run dev       # runs on http://localhost:5173
```

### Backend (local)
```bash
cd backend
pip install -r requirements.txt
# Requires: S3_BUCKET, JOBS_TABLE_NAME, ADS_TABLE_NAME, AWS_REGION env vars
python -m uvicorn handler:app
```