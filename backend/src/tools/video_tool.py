"""
Video Processing Tool - Extract frames and reconstruct video using ffmpeg subprocess.
No OpenCV dependency — uses ffmpeg CLI and PIL for image operations.
"""
import os
import re
import stat
import json
import shutil
import subprocess
import boto3
from typing import List
from config import FRAME_EXTRACTION_FPS, S3_BUCKET, AWS_REGION

s3 = boto3.client('s3', region_name=AWS_REGION)

# Locate the ffmpeg binary bundled with the Lambda package.
# In Lambda, __file__ is /var/task/src/tools/video_tool.py.
# The binary lives at /var/task/bin/ffmpeg (bundled) or falls back to PATH.
_TASK_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_BUNDLED_FFMPEG  = os.path.join(_TASK_ROOT, 'bin', 'ffmpeg')
_BUNDLED_FFPROBE = os.path.join(_TASK_ROOT, 'bin', 'ffprobe')

# ffmpeg may not be executable after a Windows zip upload — copy to /tmp and chmod once.
import tempfile as _tempfile
_TMP_DIR     = _tempfile.gettempdir()
_TMP_FFMPEG  = os.path.join(_TMP_DIR, 'ffmpeg')
_TMP_FFPROBE = os.path.join(_TMP_DIR, 'ffprobe')


def _ensure_ffmpeg() -> str:
    """Return path to an executable ffmpeg binary, copying to /tmp if needed."""
    if os.path.exists(_TMP_FFMPEG) and os.access(_TMP_FFMPEG, os.X_OK):
        return _TMP_FFMPEG

    # Copy bundled binary to writable /tmp and chmod it
    src = _BUNDLED_FFMPEG if os.path.exists(_BUNDLED_FFMPEG) else shutil.which('ffmpeg')
    if not src:
        raise RuntimeError("ffmpeg not found — please run scripts/build-backend.sh first")
    shutil.copy2(src, _TMP_FFMPEG)
    os.chmod(_TMP_FFMPEG, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)

    src_probe = _BUNDLED_FFPROBE if os.path.exists(_BUNDLED_FFPROBE) else shutil.which('ffprobe')
    if src_probe:
        shutil.copy2(src_probe, _TMP_FFPROBE)
        os.chmod(_TMP_FFPROBE, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)

    return _TMP_FFMPEG


def _ffprobe_json(video_path: str) -> dict:
    """Run ffprobe and return stream info as dict."""
    _ensure_ffmpeg()  # copies both ffmpeg + ffprobe to /tmp and chmod's them
    ffprobe = _TMP_FFPROBE
    result = subprocess.run(
        [ffprobe, '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=r_frame_rate,avg_frame_rate,duration,width,height,nb_frames',
         '-of', 'json', video_path],
        capture_output=True, text=True, check=True
    )
    return json.loads(result.stdout)


def download_video_from_s3(s3_key: str, local_path: str) -> str:
    """Download video from S3 to local temp storage."""
    s3.download_file(S3_BUCKET, s3_key, local_path)
    return local_path


def upload_video_to_s3(local_path: str, s3_key: str) -> str:
    """Upload processed video to S3."""
    s3.upload_file(local_path, S3_BUCKET, s3_key)
    return f"s3://{S3_BUCKET}/{s3_key}"


def get_video_info(video_path: str) -> dict:
    """Get video metadata using ffprobe."""
    probe = _ffprobe_json(video_path)
    streams = probe.get('streams', [{}])
    s = streams[0] if streams else {}

    # Parse fractional frame rate like "30000/1001"
    rate_str = s.get('avg_frame_rate') or s.get('r_frame_rate', '25/1')
    try:
        num, den = map(int, rate_str.split('/'))
        fps = num / den if den else 25.0
    except Exception:
        fps = 25.0

    nb_frames = int(s.get('nb_frames', 0))
    duration_str = s.get('duration')
    if duration_str:
        duration = float(duration_str)
    elif fps > 0 and nb_frames > 0:
        duration = nb_frames / fps
    else:
        duration = 0.0

    return {
        'fps': fps,
        'total_frames': nb_frames,
        'width': int(s.get('width', 0)),
        'height': int(s.get('height', 0)),
        'duration': duration,
    }


def extract_frames(video_path: str, output_dir: str, fps: int = None, max_seconds: float = None) -> List[dict]:
    """
    Extract frames from video using ffmpeg.
    Returns list of dicts: {frame_number, timestamp, path}
    """
    if fps is None:
        fps = FRAME_EXTRACTION_FPS
    if max_seconds is None:
        max_seconds = 5.0

    os.makedirs(output_dir, exist_ok=True)
    ffmpeg = _ensure_ffmpeg()

    result = subprocess.run([
        ffmpeg, '-i', video_path,
        '-t', str(max_seconds),
        '-vf', f'fps={fps}',
        '-q:v', '2',
        os.path.join(output_dir, 'frame_%06d.jpg'),
        '-y'
    ], capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg extract_frames failed (exit {result.returncode}):\n"
            + result.stderr.decode('utf-8', errors='replace')
        )

    frame_files = sorted(
        f for f in os.listdir(output_dir) if re.match(r'^frame_\d{6}\.jpg$', f)
    )

    frames_info = []
    for i, fname in enumerate(frame_files):
        frames_info.append({
            'frame_number': i,
            'original_frame': i,
            'timestamp': i / fps,
            'path': os.path.join(output_dir, fname),
        })

    return frames_info


def reconstruct_video(frames_dir: str, output_path: str, original_video_path: str, fps: int = None) -> str:
    """
    Reconstruct video from processed frames.
    Merges original audio if present.
    """
    if fps is None:
        fps = FRAME_EXTRACTION_FPS

    ffmpeg = _ensure_ffmpeg()  # copies both ffmpeg + ffprobe to /tmp
    ffprobe = _TMP_FFPROBE

    # Only include properly named processed frames
    frame_files = sorted([
        f for f in os.listdir(frames_dir)
        if re.match(r'^processed_frame_\d{6}\.jpg$', f)
    ])
    if not frame_files:
        raise ValueError("No processed frames found in directory")

    # Build a concat list so ffmpeg gets frames in exact order
    list_path = os.path.join(frames_dir, '_frame_list.txt')
    with open(list_path, 'w') as fh:
        for fname in frame_files:
            fh.write(f"file '{os.path.join(frames_dir, fname)}'\n")
            fh.write(f"duration {1.0 / fps}\n")

    temp_video = output_path.replace('.mp4', '_temp.mp4')

    # Create video from frames
    result = subprocess.run([
        ffmpeg,
        '-f', 'concat', '-safe', '0', '-i', list_path,
        '-vf', f'fps={fps}',
        '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        temp_video, '-y'
    ], capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg reconstruct_video failed (exit {result.returncode}):\n"
            + result.stderr.decode('utf-8', errors='replace')
        )

    # Check if original has audio
    try:
        result = subprocess.run(
            [ffprobe, '-v', 'error', '-select_streams', 'a',
             '-show_entries', 'stream=index', '-of', 'csv=p=0', original_video_path],
            capture_output=True, text=True
        )
        has_audio = bool(result.stdout.strip())
    except Exception:
        has_audio = False

    if has_audio:
        result = subprocess.run([
            ffmpeg, '-i', temp_video, '-i', original_video_path,
            '-c:v', 'copy', '-c:a', 'aac',
            '-map', '0:v:0', '-map', '1:a:0', '-shortest',
            output_path, '-y'
        ], capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg audio-merge failed (exit {result.returncode}):\n"
                + result.stderr.decode('utf-8', errors='replace')
            )
    else:
        shutil.move(temp_video, output_path)

    if os.path.exists(temp_video):
        os.remove(temp_video)
    if os.path.exists(list_path):
        os.remove(list_path)

    return output_path
