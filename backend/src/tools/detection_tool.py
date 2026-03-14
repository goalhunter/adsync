"""
Detection Tool - Object detection via YOLO World (local) or Amazon Rekognition (Lambda).
Controlled by DETECTOR env var: "yolo_world" or "rekognition".

Returns detections in the same format used by the rest of the pipeline:
  {label, confidence, bounding_box: {Left,Top,Width,Height}, bbox_pixels, mask}
"""
import os
import boto3
from typing import List, Dict, Any, Optional
from config import AWS_REGION, DETECTOR

rekognition = boto3.client('rekognition', region_name=AWS_REGION)

# ── YOLO World backend ──────────────────────────────────────────────────────────

_MODELS_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'models')
_DEFAULT_MODEL = os.path.join(_MODELS_DIR, 'yolov8s-worldv2.pt')
YOLO_WORLD_MODEL = os.getenv("YOLO_WORLD_MODEL", _DEFAULT_MODEL)
_yw_model = None


def _get_yolo_world():
    global _yw_model
    if _yw_model is None:
        from ultralytics import YOLOWorld
        print(f"Loading YOLO World ({YOLO_WORLD_MODEL})...")
        _yw_model = YOLOWorld(YOLO_WORLD_MODEL)
        print("YOLO World loaded.")
    return _yw_model


def detect_with_yolo_world(
    image_path: str,
    text_prompt: str,
    confidence: float = 0.1,
) -> List[Dict[str, Any]]:
    """
    YOLO World open-vocab detection for a single prompt.
    Returns a list of all detections (empty list if none found).
    """
    from PIL import Image
    image = Image.open(image_path).convert("RGB")
    img_w, img_h = image.size

    model = _get_yolo_world()
    model.set_classes([text_prompt])
    results = model.predict(image_path, conf=confidence, verbose=False)

    detections = []
    for box in results[0].boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        x1, y1 = max(0.0, x1), max(0.0, y1)
        x2, y2 = min(float(img_w), x2), min(float(img_h), y2)
        detections.append({
            "label":      text_prompt,
            "confidence": float(box.conf[0]),
            "bounding_box": {
                "Left":   x1 / img_w,
                "Top":    y1 / img_h,
                "Width":  (x2 - x1) / img_w,
                "Height": (y2 - y1) / img_h,
            },
            "bbox_pixels": [int(x1), int(y1), int(x2), int(y2)],
            "mask": None,
        })
    return detections


def detect_labels_in_image(image_path: str, min_confidence: float = 0.20) -> List[Dict[str, Any]]:
    """
    Run Rekognition DetectLabels on a JPEG frame.
    Returns all labels that have at least one bounding-box instance.
    """
    return detect_labels_full(image_path, min_confidence)['bbox_detections']


def detect_labels_full(image_path: str, min_confidence: float = 0.10) -> Dict[str, Any]:
    """
    Single Rekognition call that returns:
      bbox_detections : list of detections WITH bounding boxes (usable for placement)
      all_label_names : list of ALL label names including scene-level ones without bboxes
    """
    with open(image_path, 'rb') as f:
        image_bytes = f.read()

    response = rekognition.detect_labels(
        Image={'Bytes': image_bytes},
        MaxLabels=50,
        MinConfidence=int(min_confidence * 100),
    )

    bbox_detections = []
    all_label_names = []

    for label in response.get('Labels', []):
        all_label_names.append(label['Name'])
        for instance in label.get('Instances', []):
            bb = instance.get('BoundingBox')
            if not bb:
                continue
            bbox_detections.append({
                'label': label['Name'],
                'confidence': instance['Confidence'] / 100.0,
                'bounding_box': {
                    'Left':   bb['Left'],
                    'Top':    bb['Top'],
                    'Width':  bb['Width'],
                    'Height': bb['Height'],
                },
                'bbox_pixels': None,
                'mask': None,
            })

    return {'bbox_detections': bbox_detections, 'all_label_names': all_label_names}


def _label_matches_prompt(label_name: str, prompt: str) -> bool:
    """Return True if the Rekognition label matches the YOLO-style text prompt."""
    label_lower = label_name.lower()
    prompt_lower = prompt.lower().strip()
    # Exact match or substring match in either direction
    if prompt_lower in label_lower or label_lower in prompt_lower:
        return True
    # Word-level match: any word in the prompt appears in the label
    for word in prompt_lower.split():
        if len(word) >= 3 and (word in label_lower or label_lower in word):
            return True
    return False


def detect_with_rekognition(
    image_path: str,
    text_prompt: str,
    confidence: float = 0.20,
) -> List[Dict[str, Any]]:
    """
    Detect objects matching text_prompt in the image.
    Equivalent to detect_with_yolo_world() but uses Rekognition.
    """
    all_detections = detect_labels_in_image(image_path, min_confidence=confidence)
    return [d for d in all_detections if _label_matches_prompt(d['label'], text_prompt)]


def detect_best_match(
    image_path: str,
    text_prompt: str,
    confidence: float = 0.20,
) -> Optional[Dict[str, Any]]:
    """Return the highest-confidence detection matching text_prompt, or None."""
    detections = detect_with_rekognition(image_path, text_prompt, confidence)
    if not detections:
        return None
    return max(detections, key=lambda d: d['confidence'])


def detect_with_prompts(
    image_path: str,
    prompts: List[str],
    confidence: float = 0.10,
) -> Optional[Dict[str, Any]]:
    """
    Try each prompt in order and return the best detection.
    Routes to YOLO World (local) or Rekognition (Lambda) based on DETECTOR config.
    """
    if DETECTOR == "yolo_world":
        if isinstance(prompts, str):
            prompts = [prompts]
        for prompt in prompts:
            results = detect_with_yolo_world(image_path, prompt, confidence)
            if results:
                if prompt != prompts[0]:
                    print(f"    matched via fallback keyword '{prompt}'")
                return max(results, key=lambda d: d["confidence"])
        return None

    # Rekognition path: fetch all labels once then match each prompt
    if isinstance(prompts, str):
        prompts = [prompts]

    all_detections = detect_labels_in_image(image_path, min_confidence=confidence)

    for prompt in prompts:
        matches = [d for d in all_detections if _label_matches_prompt(d['label'], prompt)]
        if matches:
            best = max(matches, key=lambda d: d['confidence'])
            if prompt != prompts[0]:
                print(f"    matched via fallback keyword '{prompt}' -> '{best['label']}'")
            return best

    return None
