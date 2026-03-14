"""
AdSync — Flask Server

Runs the full API and video processing pipeline in-process.
Uses real AWS services: S3, DynamoDB, Rekognition, Bedrock.

Usage:
  cd backend
  pip install -r requirements.txt
  python server.py

API listens on http://localhost:4000
"""
import os
import sys
import json
import uuid
import shutil
import tempfile
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal
from datetime import datetime, timezone

# ── Environment defaults ───────────────────────────────────────────────────────
os.environ.setdefault("S3_BUCKET",        "video-ad-placer-bucket")
os.environ.setdefault("JOBS_TABLE_NAME",  "video-ad-placer-jobs")
os.environ.setdefault("ADS_TABLE_NAME",   "video-ad-placer-ads")
os.environ.setdefault("AWS_REGION",       "us-east-1")
os.environ.setdefault("NOVA_MODEL_ID",    "amazon.nova-pro-v1:0")
os.environ.setdefault("DETECTOR",         "rekognition")

# ── Python path ────────────────────────────────────────────────────────────────
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# ── AWS clients ────────────────────────────────────────────────────────────────
import boto3

REGION           = os.environ["AWS_REGION"]
S3_BUCKET        = os.environ["S3_BUCKET"]
JOBS_TABLE_NAME  = os.environ["JOBS_TABLE_NAME"]
ADS_TABLE_NAME   = os.environ["ADS_TABLE_NAME"]
NOVA_MODEL_ID    = os.environ["NOVA_MODEL_ID"]
PRESIGNED_EXPIRY = 3600

s3       = boto3.client('s3',              region_name=REGION)
bedrock  = boto3.client('bedrock-runtime', region_name=REGION)
dynamodb = boto3.resource('dynamodb',      region_name=REGION)

jobs_table = dynamodb.Table(JOBS_TABLE_NAME)
ads_table  = dynamodb.Table(ADS_TABLE_NAME)

_AD_CATEGORIES = [
    'beverage', 'automotive', 'technology', 'coffee',
    'sportswear', 'luxury', 'finance', 'outdoor', 'billboard', 'other'
]

# ── Tool imports ───────────────────────────────────────────────────────────────
from src.tools.database_tool import get_available_ads
from src.tools.video_tool import (
    download_video_from_s3, upload_video_to_s3,
    extract_frames, reconstruct_video, get_video_info,
)
from src.tools.scene_analysis_tool import analyze_video_scene, detect_targets_in_frames
from src.tools.frame_manipulation_tool import (
    process_frame_with_strategy,
    draw_detection_mask,
)


# ── Helpers ────────────────────────────────────────────────────────────────────

class _DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return super().default(o)


def _json(data):
    return json.dumps(data, cls=_DecimalEncoder)


def _presigned_url(s3_key: str, expires: int = PRESIGNED_EXPIRY) -> str:
    return s3.generate_presigned_url(
        'get_object',
        Params={'Bucket': S3_BUCKET, 'Key': s3_key},
        ExpiresIn=expires,
    )


def _update_job(job_id: str, updates: dict):
    set_expr   = ", ".join(f"#f{i} = :v{i}" for i, k in enumerate(updates))
    attr_names = {f"#f{i}": k for i, k in enumerate(updates)}
    attr_vals  = {f":v{i}": v for i, (k, v) in enumerate(updates.items())}
    jobs_table.update_item(
        Key={"job_id": job_id},
        UpdateExpression=f"SET {set_expr}",
        ExpressionAttributeNames=attr_names,
        ExpressionAttributeValues=attr_vals,
    )


def _download_ad_assets(ads: list, work_dir: str) -> list:
    assets_dir = os.path.join(work_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    updated = []
    for ad in ads:
        ad = dict(ad)
        s3_key = ad.get("asset_s3_key") or ad.get("asset_local_path", "")
        if s3_key and not os.path.isabs(s3_key):
            local_path = os.path.join(assets_dir, os.path.basename(s3_key))
            try:
                s3.download_file(S3_BUCKET, s3_key, local_path)
                ad["asset_local_path"] = local_path
            except Exception as e:
                print(f"Failed to download asset {s3_key}: {e}")
        updated.append(ad)
    return updated


# ── Video processing pipeline ──────────────────────────────────────────────────

def _process_video(s3_key: str, job_id: str, confidence_threshold: float = 0.7,
                   fps: int = 5, max_seconds: float = 5.0):
    work_dir      = tempfile.mkdtemp(prefix=f"adsync_{job_id}_")
    frames_dir    = os.path.join(work_dir, "frames")
    processed_dir = os.path.join(work_dir, "processed")
    os.makedirs(frames_dir,    exist_ok=True)
    os.makedirs(processed_dir, exist_ok=True)

    try:
        # Step 0: Download video
        print(f"[{job_id}] Downloading video: {s3_key}")
        local_video = os.path.join(work_dir, "input_video.mp4")
        download_video_from_s3(s3_key, local_video)

        # Step 1: Fetch ads
        print(f"[{job_id}] Fetching ads...")
        available_ads = get_available_ads()
        if not available_ads:
            _update_job(job_id, {"status": "error", "error": "No ads available",
                                  "completed_at": datetime.now(timezone.utc).isoformat()})
            return
        available_ads = _download_ad_assets(available_ads, work_dir)
        ads_by_id     = {ad["ad_id"]: ad for ad in available_ads}
        print(f"[{job_id}] {len(available_ads)} ads: {[a['brand'] for a in available_ads]}")

        # Step 2: Extract frames
        print(f"[{job_id}] Extracting frames...")
        video_info  = get_video_info(local_video)
        frames_info = extract_frames(local_video, frames_dir, fps=fps, max_seconds=max_seconds)
        if not frames_info:
            _update_job(job_id, {"status": "error", "error": "Failed to extract frames",
                                  "completed_at": datetime.now(timezone.utc).isoformat()})
            return
        frame_paths = [f['path'] for f in frames_info]
        print(f"[{job_id}] {len(frame_paths)} frames ({video_info['duration']:.1f}s)")

        # Step 3: Nova Pro scene analysis
        n              = len(frame_paths)
        sample_indices = sorted(set(min(i, n-1) for i in [0, n//4, n//2, 3*n//4, n-1]))
        sample_frames  = [frame_paths[i] for i in sample_indices]
        print(f"[{job_id}] Analyzing scene...")
        scene_result      = analyze_video_scene(sample_frames, available_ads)
        targets           = scene_result["targets"]
        scene_description = scene_result["scene_description"]
        nova_candidates   = scene_result["candidates"]
        reasoning         = scene_result["reasoning"]

        _update_job(job_id, {
            "scene_description": scene_description,
            "nova_candidates":   json.dumps(nova_candidates),
            "reasoning":         reasoning,
        })

        if not targets:
            _update_job(job_id, {
                "status":       "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "placements":   json.dumps([]),
                "reasoning":    reasoning,
            })
            return

        # Single brand per video
        first_ad_id = targets[0].get("ad_id")
        targets = [t for t in targets if t.get("ad_id") == first_ad_id][:1]

        # Step 4: Object detection
        print(f"[{job_id}] Detecting targets in {len(frame_paths)} frames...")
        placements = detect_targets_in_frames(frame_paths, targets)
        if not placements:
            _update_job(job_id, {
                "status":       "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "placements":   json.dumps([]),
                "reasoning":    reasoning,
            })
            return

        # Step 4.5: Detection mask video
        print(f"[{job_id}] Building detection visualization...")
        mask_frames_dir = os.path.join(work_dir, "mask_frames")
        os.makedirs(mask_frames_dir, exist_ok=True)
        placements_by_frame_for_mask = defaultdict(list)
        for result in placements:
            fname = os.path.basename(result["frame_path"])
            placements_by_frame_for_mask[fname].extend(result.get("placements", []))
        for f in frames_info:
            fname    = os.path.basename(f['path'])
            out_path = os.path.join(mask_frames_dir, f"processed_{fname}")
            if fname in placements_by_frame_for_mask:
                try:
                    draw_detection_mask(f['path'], placements_by_frame_for_mask[fname], ads_by_id, out_path)
                except Exception:
                    shutil.copy(f['path'], out_path)
            else:
                shutil.copy(f['path'], out_path)
        mask_video_path = os.path.join(work_dir, "detection_video.mp4")
        try:
            reconstruct_video(mask_frames_dir, mask_video_path, local_video, fps=fps)
        except Exception as e:
            print(f"[{job_id}] Detection video failed: {e}")
            mask_video_path = None

        # Step 5: Overlay ads on frames
        placements_by_frame = defaultdict(list)
        for result in placements:
            placements_by_frame[os.path.basename(result["frame_path"])].append(result)

        placement_summary = []
        processed_frames  = set()
        summary_lock      = threading.Lock()
        chain_dir         = os.path.join(work_dir, "chain")
        os.makedirs(chain_dir, exist_ok=True)

        def _process_one_frame(frame_name, frame_results):
            original_path = frame_results[0]["frame_path"]
            frame_info    = next((f for f in frames_info if f['path'] == original_path), None)
            timestamp     = frame_info['timestamp'] if frame_info else 0
            chain_path    = os.path.join(chain_dir, frame_name)
            current_input = original_path
            any_success   = False
            for result in frame_results:
                placement = (result.get("placements") or [None])[0]
                if not placement:
                    continue
                try:
                    output = process_frame_with_strategy(
                        frame_path=current_input,
                        placement=placement,
                        ads_mapping=ads_by_id,
                        output_dir=processed_dir,
                    )
                    if output:
                        shutil.copy(output, chain_path)
                        current_input = chain_path
                        any_success   = True
                        ad_info = ads_by_id.get(placement.get("ad_id"), {})
                        with summary_lock:
                            placement_summary.append({
                                "timestamp":      round(timestamp, 2),
                                "brand":          ad_info.get("brand", "Unknown"),
                                "category":       ad_info.get("category", "unknown"),
                                "target_object":  placement.get("target_object", ""),
                                "placement_type": placement.get("placement_type", ""),
                                "confidence":     placement.get("confidence", 0),
                            })
                except Exception as e:
                    print(f"[{job_id}] Frame {frame_name} failed: {e}")
            return frame_name if any_success else None

        print(f"[{job_id}] Processing {len(placements_by_frame)} frames...")
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(_process_one_frame, fn, fr): fn
                for fn, fr in placements_by_frame.items()
            }
            for future in as_completed(futures):
                result = future.result()
                if result:
                    processed_frames.add(result)

        # Step 6: Copy unprocessed frames
        for f in frames_info:
            fname = os.path.basename(f['path'])
            if fname not in processed_frames:
                shutil.copy(f['path'], os.path.join(processed_dir, f"processed_{fname}"))

        # Step 7: Reconstruct final video
        print(f"[{job_id}] Reconstructing final video...")
        output_path = os.path.join(work_dir, "output_video.mp4")
        reconstruct_video(processed_dir, output_path, local_video, fps=fps)

        # Step 8: Upload to S3
        print(f"[{job_id}] Uploading to S3...")
        detection_video_url = None
        det_key = None
        if mask_video_path and os.path.exists(mask_video_path):
            det_key = f"output/{job_id}_detection.mp4"
            upload_video_to_s3(mask_video_path, det_key)
            detection_video_url = _presigned_url(det_key)

        output_key = f"output/{job_id}_adplaced.mp4"
        upload_video_to_s3(output_path, output_key)

        _update_job(job_id, {
            "status":              "completed",
            "completed_at":        datetime.now(timezone.utc).isoformat(),
            "output_video":        _presigned_url(output_key),
            "output_video_key":    output_key,
            "detection_video":     detection_video_url or "",
            "detection_video_key": det_key or "",
            "total_placements":    len(placement_summary),
            "frames_processed":    len(processed_frames),
            "frames_total":        len(frame_paths),
            "video_duration":      str(video_info['duration']),
            "placements":          json.dumps(placement_summary),
            "reasoning":           reasoning,
            "scene_description":   scene_description,
        })
        print(f"[{job_id}] Done. {len(placement_summary)} placements.")

    except Exception as e:
        import traceback
        print(f"[{job_id}] Error: {e}\n{traceback.format_exc()}")
        _update_job(job_id, {
            "status":       "error",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "error":        str(e),
        })
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


# ── Flask ──────────────────────────────────────────────────────────────────────
try:
    from flask import Flask, request, Response
except ImportError:
    print("\n[ERROR] Flask is not installed. Run: pip install -r requirements.txt\n")
    sys.exit(1)

app = Flask(__name__)


@app.after_request
def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"]  = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
    return resp


@app.route("/<path:_>", methods=["OPTIONS"])
def _preflight(_):
    return Response("{}", status=200, mimetype="application/json")


def ok(data, status=200):
    return Response(_json(data), status=status, mimetype="application/json")


def err(msg, status=400):
    return Response(_json({"error": msg}), status=status, mimetype="application/json")


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/upload-url", methods=["POST"])
def upload_url():
    filename  = request.args.get("filename", "video.mp4")
    safe_name = "".join(c for c in filename if c.isalnum() or c in "._-")
    s3_key    = f"input/{uuid.uuid4()}_{safe_name}"
    url = s3.generate_presigned_url(
        'put_object',
        Params={'Bucket': S3_BUCKET, 'Key': s3_key, 'ContentType': 'video/mp4'},
        ExpiresIn=PRESIGNED_EXPIRY
    )
    return ok({"upload_url": url, "s3_key": s3_key})


@app.route("/process", methods=["POST"])
def process_video():
    body   = request.get_json(silent=True) or {}
    s3_key = body.get("s3_key")
    if not s3_key:
        return err("s3_key is required")

    job_id = str(uuid.uuid4())[:8]
    jobs_table.put_item(Item={
        "job_id":               job_id,
        "status":               "processing",
        "s3_key":               s3_key,
        "created_at":           datetime.now(timezone.utc).isoformat(),
        "confidence_threshold": str(body.get("confidence_threshold", 0.7)),
        "fps":                  str(body.get("fps", 5)),
        "max_seconds":          str(body.get("max_seconds", 5.0)),
    })

    threading.Thread(
        target=_process_video,
        args=(s3_key, job_id),
        kwargs={
            "confidence_threshold": body.get("confidence_threshold", 0.7),
            "fps":                  body.get("fps", 5),
            "max_seconds":          body.get("max_seconds", 5.0),
        },
        daemon=True
    ).start()

    return ok({"job_id": job_id, "status": "processing"}, status=202)


@app.route("/job/<job_id>", methods=["GET"])
def get_job(job_id):
    item = jobs_table.get_item(Key={"job_id": job_id}).get("Item")
    if not item:
        return err(f"Job '{job_id}' not found", 404)
    return ok(item)


@app.route("/jobs", methods=["GET"])
def list_jobs():
    jobs = jobs_table.scan(
        FilterExpression="attribute_exists(completed_at)"
    ).get("Items", [])
    for job in jobs:
        for key_field, url_field in [
            ("output_video_key",    "output_video"),
            ("detection_video_key", "detection_video"),
        ]:
            s3_key = job.get(key_field)
            if s3_key:
                try:
                    job[url_field] = _presigned_url(s3_key)
                except Exception:
                    pass
    jobs.sort(key=lambda j: j.get("completed_at", ""), reverse=True)
    return ok({"jobs": jobs})


@app.route("/jobs/<job_id>", methods=["DELETE"])
def delete_job(job_id):
    item = jobs_table.get_item(Key={"job_id": job_id}).get("Item")
    if not item:
        return err(f"Job '{job_id}' not found", 404)
    for key_field in ("output_video_key", "detection_video_key"):
        s3_key = item.get(key_field)
        if s3_key:
            try:
                s3.delete_object(Bucket=S3_BUCKET, Key=s3_key)
            except Exception:
                pass
    jobs_table.delete_item(Key={"job_id": job_id})
    return ok({"deleted": job_id})


@app.route("/ads", methods=["GET"])
def list_ads():
    ads = ads_table.scan().get("Items", [])
    for ad in ads:
        key = ad.get("asset_s3_key") or ad.get("asset_local_path", "")
        if key:
            try:
                ad["image_url"] = _presigned_url(key)
            except Exception:
                ad["image_url"] = ""
    return ok({"ads": ads})


@app.route("/ads/upload-url", methods=["GET"])
def ad_upload_url():
    filename     = request.args.get("filename", "logo.png")
    content_type = request.args.get("content_type", "image/png")
    safe_name    = "".join(c for c in filename if c.isalnum() or c in "._-")
    s3_key       = f"assets/ads/uploads/{uuid.uuid4()}_{safe_name}"
    url = s3.generate_presigned_url(
        'put_object',
        Params={'Bucket': S3_BUCKET, 'Key': s3_key, 'ContentType': content_type},
        ExpiresIn=PRESIGNED_EXPIRY
    )
    return ok({"upload_url": url, "s3_key": s3_key})


@app.route("/ads/analyze", methods=["POST"])
def analyze_ad():
    body         = request.get_json(silent=True) or {}
    image_b64    = body.get("image_base64", "").strip()
    content_type = body.get("content_type", "image/png")
    if not image_b64:
        return err("image_base64 is required")
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    fmt = ("jpeg" if any(x in content_type for x in ("jpeg", "jpg")) else
           "gif"  if "gif"  in content_type else
           "webp" if "webp" in content_type else "png")

    prompt = (
        f"Analyze this logo/advertisement image and extract metadata for an ad catalog.\n"
        f"Return ONLY a valid JSON object with these exact fields:\n"
        f'{{\n'
        f'  "brand": "brand or company name visible in the image",\n'
        f'  "category": "one of: {", ".join(_AD_CATEGORIES)}",\n'
        f'  "ad_type": "logo if it is a simple logo/icon, poster if it is a full advertisement",\n'
        f'  "keywords": ["3-8 keywords for surfaces/objects where this ad naturally appears"],\n'
        f'  "description": "one sentence describing the advertisement",\n'
        f'  "image_description": "visual description of colors, shapes, and text for AI placement"\n'
        f"}}\n\n"
        f"- category must be exactly one of the listed options\n"
        f"- image_description must mention colors, shapes, style"
    )

    try:
        response = bedrock.invoke_model(
            modelId=NOVA_MODEL_ID,
            body=json.dumps({
                "messages": [{"role": "user", "content": [
                    {"image": {"format": fmt, "source": {"bytes": image_b64}}},
                    {"text": prompt}
                ]}],
                "inferenceConfig": {"maxTokens": 500, "temperature": 0.1}
            })
        )
        text    = json.loads(response['body'].read())['output']['message']['content'][0]['text']
        j_start = text.find('{')
        j_end   = text.rfind('}') + 1
        if j_start == -1 or j_end <= j_start:
            return err("Nova Pro returned no JSON", 500)
        return ok(json.loads(text[j_start:j_end]))
    except Exception as e:
        return err(str(e), 500)


@app.route("/ads", methods=["POST"])
def create_ad():
    body     = request.get_json(silent=True) or {}
    brand    = body.get("brand", "").strip()
    category = body.get("category", "").strip()
    s3_key   = body.get("asset_s3_key", "").strip()
    if not brand or not category or not s3_key:
        return err("brand, category and asset_s3_key are required")

    ad_id = f"ad-{uuid.uuid4().hex[:6]}"
    item  = {
        "ad_id":             ad_id,
        "brand":             brand,
        "category":          category,
        "ad_type":           body.get("ad_type", "logo"),
        "keywords":          body.get("keywords", []),
        "asset_s3_key":      s3_key,
        "asset_local_path":  s3_key,
        "priority":          10,
        "description":       body.get("description", f"{brand} advertisement"),
        "image_description": body.get("image_description", ""),
    }
    ads_table.put_item(Item=item)
    return ok({"ad": item}, status=201)


@app.route("/ads/<ad_id>", methods=["DELETE"])
def delete_ad(ad_id):
    ads_table.delete_item(Key={"ad_id": ad_id})
    return ok({"deleted": ad_id})


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  AdSync — API Server")
    print("=" * 60)
    print(f"  URL    : http://localhost:4000")
    print(f"  S3     : {S3_BUCKET}")
    print(f"  Jobs   : {JOBS_TABLE_NAME}")
    print(f"  Ads    : {ADS_TABLE_NAME}")
    print(f"  Region : {REGION}")
    print("=" * 60)
    app.run(host="0.0.0.0", port=4000, debug=False, threaded=True)
