"""
Scene Analysis Tool - Nova Pro analyzes the scene and guides Rekognition detection.
Pipeline: Nova Pro (what to target) → Rekognition (find it precisely) → place ads
"""
import boto3
import json
import base64
from typing import List, Dict, Any, Optional
from config import NOVA_MODEL_ID, AWS_REGION, MAX_PLACEMENTS_PER_VIDEO, STRATEGIST_MIN_CONFIDENCE, DETECTOR

bedrock = boto3.client('bedrock-runtime', region_name=AWS_REGION)


def encode_image(image_path: str) -> str:
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode('utf-8')


def format_ad_catalog_for_prompt(available_ads: List[Dict[str, Any]]) -> str:
    lines = ["=== AVAILABLE ADS ==="]
    for ad in available_ads:
        lines.append(
            f"- ad_id: {ad['ad_id']}, brand: {ad['brand']}, "
            f"category: {ad['category']}, "
            f"ad_type: {ad.get('ad_type', 'logo')}, "
            f"visual: {ad.get('image_description', ad.get('description', 'N/A'))}"
        )
    return "\n".join(lines)


def analyze_video_scene(
    sample_frame_paths: List[str],
    available_ads: List[Dict[str, Any]],
    max_targets: int = MAX_PLACEMENTS_PER_VIDEO,
) -> List[Dict[str, Any]]:
    """
    Nova Pro analyzes sample frames and decides WHAT to target for ad placement.
    Returns a list of target dicts with yolo_prompts used by Rekognition detection.
    """
    ad_catalog_text = format_ad_catalog_for_prompt(available_ads)

    content = []
    for path in sample_frame_paths:
        content.append({
            "image": {
                "format": "jpeg",
                "source": {"bytes": encode_image(path)}
            }
        })

    prompt = f"""You are a senior advertising placement strategist analyzing a video.
I'm showing you {len(sample_frame_paths)} sample frames from this video.

{ad_catalog_text}

YOUR TASK: Follow these steps IN ORDER. Do not skip any step.

STEP 1 — LIST ALL CANDIDATE SURFACES:
Carefully scan every frame and explicitly list EVERY surface you can see that could hold a logo.
For each surface note: what it is, how large it appears, how stable/flat it is, and whether it is
near the center of frame or at the edge. Do not skip surfaces — list them all before deciding.

STEP 2 — SCORE AND RANK THE SURFACES:
Score each surface on these criteria (higher = better):
  - CONTEXTUAL FIT with available ads: does any ad belong naturally on this surface? (biggest weight)
  - STABILITY: is it slow-moving or still? Fast-moving/spinning = disqualified
  - VISIBILITY: is the surface clearly visible and well-lit?
  - POSITION: surfaces near the center of frame score higher than those at the edges
Size alone is NOT a criterion. A small cup that perfectly fits a beverage brand scores higher
than a large laptop that doesn't. The goal is the most believable, natural-looking placement.

STEP 3 — PICK THE WINNER AND MATCH AN AD:
From all surfaces, find the combination of (surface + ad) that would look most natural to a viewer.
Ask: if this brand sponsored this video, where would their logo most believably appear?
TIE-BREAK: if two combinations score equally, prefer the surface closer to the center of the frame.

RULES:
1. LESS IS MORE — return ZERO targets rather than a bad placement.
2. STABILITY IS NON-NEGOTIABLE — if a surface is spinning, bouncing, or moving fast, disqualify it.
3. CONTEXTUAL FIT BEATS SIZE: always ask — would a real viewer believe this brand naturally
   belongs on this surface?
4. PICK EXACTLY ONE BRAND for the entire video. All targets must use the same ad_id.
5. Each target surface gets exactly ONE ad.
6. For target_description: plain name of the object, e.g. "shopping bag", "laptop", "hoodie".
7. For yolo_prompts: ranked list of 2-3 Rekognition-style label keywords.
   Rules for each keyword:
   - Plain category noun only. NO colors, NO adjectives, NO qualifiers.
   - Start with the most specific term, then broaden.
   - Examples: ["Handbag", "Bag"], ["Laptop", "Computer"], ["Coffee Cup", "Cup"]
   - Use standard Rekognition label names: Person, Laptop, Handbag, Backpack,
     Cup, Bottle, Chair, Monitor, Cell Phone, Jacket, Hoodie, Shirt, Shoe
8. For placement_type — use the ad_type from the catalog:
   - "surface_replacement": the ad asset fills the entire detected surface area.
   - "logo_swap": the ad asset is placed centered on the surface at logo_scale size.
9. For logo_scale: decide what fraction of the detected surface the ad should occupy (0.1 – 1.0).

Return AT MOST {max_targets} targets, all using the SAME ad_id.

Respond in STRICT JSON (no extra text):
{{
    "scene_description": "brief description of what's happening in the video",
    "candidates": ["list every surface you identified"],
    "reasoning": "2-3 sentence explanation: which ad you chose, which surface, and WHY this specific (ad + surface) combination is the most natural and believable placement for a real viewer",
    "targets": [
        {{
            "ad_id": "which ad to place from the catalog",
            "target_description": "plain object name e.g. 'bag', 'laptop', 'hoodie'",
            "yolo_prompts": ["ranked keywords e.g. 'Handbag'", "'Bag'"],
            "detection_method": "rekognition",
            "placement_type": "surface_replacement or logo_swap",
            "logo_scale": 0.1 to 1.0,
            "confidence": 0.0 to 1.0
        }}
    ]
}}

If nothing is suitable, return empty targets array with a reasoning explaining why no placement was possible."""

    content.append({"text": prompt})

    request_body = {
        "messages": [{"role": "user", "content": content}],
        "inferenceConfig": {"maxTokens": 1500, "temperature": 0.1}
    }

    response = bedrock.invoke_model(modelId=NOVA_MODEL_ID, body=json.dumps(request_body))
    response_body = json.loads(response['body'].read())
    result_text = response_body['output']['message']['content'][0]['text']

    try:
        json_start = result_text.find('{')
        json_end = result_text.rfind('}') + 1
        if json_start == -1 or json_end <= json_start:
            return []
        result = json.loads(result_text[json_start:json_end])
    except json.JSONDecodeError:
        return []

    scene = result.get("scene_description", "")
    if scene:
        print(f"  Scene: {scene}")
    candidates = result.get("candidates", [])
    if candidates:
        print(f"  Candidates seen: {', '.join(candidates)}")
    reasoning = result.get("reasoning", "")
    if reasoning:
        print(f"  Reasoning: {reasoning}")

    targets = [t for t in result.get("targets", []) if t.get("confidence", 0) >= STRATEGIST_MIN_CONFIDENCE]
    return {
        "targets": targets,
        "scene_description": scene,
        "candidates": candidates,
        "reasoning": reasoning,
    }


def nova_select_best_label(
    target_description: str,
    bbox_labels: List[str],
    all_labels: List[str] = None,
) -> Optional[str]:
    """
    Ask Nova to pick which Rekognition bbox label best maps to the target object.
    all_labels includes scene-level labels (no bbox) for extra context.
    Called once per target — not per frame.
    """
    if not bbox_labels:
        return None

    scene_only = sorted(set(all_labels or []) - set(bbox_labels))
    context_line = (
        f"\nFor context, Rekognition also detected these scene-level labels "
        f"(no bounding boxes, cannot be used): {', '.join(scene_only)}\n"
        if scene_only else ""
    )

    bbox_list = "\n".join(f"- {l}" for l in sorted(bbox_labels))
    prompt = (
        f'I need to place an ad on a "{target_description}" in a video.\n'
        f"{context_line}\n"
        f"These Rekognition labels have bounding boxes and CAN be used for placement:\n"
        f"{bbox_list}\n\n"
        f"Important: Rekognition's vocabulary is imprecise for food and drink. For example:\n"
        f"  - A glass of iced coffee is often labeled 'Beer' or 'Soda'\n"
        f"  - A French press is often labeled 'Shaker' or 'Coffee Maker'\n"
        f"  - A coffee cup may appear as 'Cup', 'Mug', or 'Bottle'\n\n"
        f"Pick the label from the bounding-box list that MOST LIKELY corresponds to "
        f'"{target_description}" or occupies the same region of the image. '
        f"An imprecise label name is fine — the bounding box location is what matters.\n"
        f'Only reply "none" if NO label could plausibly be in the same location as the target.\n'
        f'Reply with ONLY the exact label name from the bounding-box list, or "none".'
    )

    try:
        response = bedrock.invoke_model(
            modelId=NOVA_MODEL_ID,
            body=json.dumps({
                "messages": [{"role": "user", "content": [{"text": prompt}]}],
                "inferenceConfig": {"maxTokens": 30, "temperature": 0},
            })
        )
        selected = json.loads(response['body'].read())['output']['message']['content'][0]['text'].strip()
        if selected.lower() == "none":
            return None
        for label in bbox_labels:
            if label.lower() == selected.lower():
                return label
        for label in bbox_labels:
            if selected.lower() in label.lower() or label.lower() in selected.lower():
                return label
        print(f"  Nova returned '{selected}' which isn't in bbox list — ignoring")
        return None
    except Exception as e:
        print(f"  Nova label selection failed: {e}")
        return None


def detect_targets_in_frames(
    frame_paths: List[str],
    targets: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Find targets Nova Pro identified in every frame.

    YOLO World path (local):
      Directly runs open-vocab detection per frame using yolo_prompts.
      No label-discovery step needed — YOLO World understands arbitrary text.

    Rekognition path (Lambda):
      1. Run Rekognition on sample frames to discover available bbox labels.
      2. Ask Nova to map target description → best Rekognition label.
      3. Use that label to filter per-frame Rekognition results.
         Falls back to yolo_prompts substring matching if Nova can't map.
    """
    from src.tools.detection_tool import detect_labels_full, detect_with_prompts

    all_placements = []

    if DETECTOR == "yolo_world":
        # ── YOLO World: keyword election across all frames, then use best ──────
        from src.tools.detection_tool import detect_with_yolo_world
        print(f"  Detector: YOLO World")

        for target in targets:
            ad_id          = target.get("ad_id")
            placement_type = target.get("placement_type", "surface_replacement")
            target_desc    = target.get("target_description", "")
            yolo_prompts   = target.get("yolo_prompts") or [target_desc.split()[-1]]
            logo_scale     = float(target.get("logo_scale", 0.5))

            print(f"  Detecting '{target_desc}' in {len(frame_paths)} frames...")
            print(f"    yolo_prompts to evaluate: {yolo_prompts}")

            # Phase 1: elect best keyword — test each across ALL frames, pick most hits
            best_keyword = yolo_prompts[0]
            best_hits = {}  # frame_path -> best detection result

            for keyword in yolo_prompts:
                hits = {}
                for frame_path in frame_paths:
                    results = detect_with_yolo_world(frame_path, keyword, confidence=0.1)
                    if results:
                        hits[frame_path] = max(results, key=lambda d: d["confidence"])
                print(f"    '{keyword}': {len(hits)}/{len(frame_paths)} frames")
                if len(hits) > len(best_hits):
                    best_hits = hits
                    best_keyword = keyword
                if len(best_hits) == len(frame_paths):
                    break  # all frames covered, stop early

            print(f"    Best keyword: '{best_keyword}' ({len(best_hits)}/{len(frame_paths)} frames)")

            if len(frame_paths) > 0 and len(best_hits) / len(frame_paths) < 0.3:
                print(f"    YOLO World found too few frames, skipping.")

            for frame_path, result in best_hits.items():
                all_placements.append({
                    "frame_path": frame_path,
                    "placements": [{
                        "ad_id":          ad_id,
                        "target_object":  target_desc,
                        "bounding_box":   result["bounding_box"],
                        "mask":           None,
                        "placement_type": placement_type,
                        "logo_scale":     logo_scale,
                        "confidence":     result["confidence"],
                    }],
                    "reasoning": f"Nova Pro target: {target_desc}",
                })

    else:
        # ── Rekognition: label-discovery + Nova mapping + per-frame detection ──
        print(f"  Detector: Rekognition")
        n = len(frame_paths)
        sample_indices = sorted(set(min(i, n - 1) for i in [0, n // 4, n // 2, 3 * n // 4, n - 1]))
        seen_bbox_labels = set()
        seen_all_labels  = set()
        for idx in sample_indices:
            result = detect_labels_full(frame_paths[idx], min_confidence=0.10)
            seen_bbox_labels.update(d['label'] for d in result['bbox_detections'])
            seen_all_labels.update(result['all_label_names'])
        print(f"  Rekognition bbox labels: {', '.join(sorted(seen_bbox_labels))}")
        print(f"  All Rekognition labels:  {', '.join(sorted(seen_all_labels))}")

        for target in targets:
            ad_id          = target.get("ad_id")
            placement_type = target.get("placement_type", "surface_replacement")
            target_desc    = target.get("target_description", "")
            yolo_prompts   = target.get("yolo_prompts") or [target_desc]
            logo_scale     = float(target.get("logo_scale", 0.5))

            selected_label = nova_select_best_label(target_desc, list(seen_bbox_labels), list(seen_all_labels))
            if selected_label:
                print(f"  Nova mapped '{target_desc}' → '{selected_label}'")
            else:
                print(f"  Nova couldn't map '{target_desc}' — falling back to prompts {yolo_prompts}")

            print(f"  Detecting '{target_desc}' in {len(frame_paths)} frames...")
            hits = 0
            for frame_path in frame_paths:
                all_dets = detect_labels_full(frame_path, min_confidence=0.10)['bbox_detections']

                result = None
                if selected_label:
                    matches = [d for d in all_dets if d['label'].lower() == selected_label.lower()]
                    if matches:
                        result = max(matches, key=lambda d: d['confidence'])

                if result is None:
                    result = detect_with_prompts(frame_path, yolo_prompts, confidence=0.10)

                if result:
                    all_placements.append({
                        "frame_path": frame_path,
                        "placements": [{
                            "ad_id":          ad_id,
                            "target_object":  target_desc,
                            "bounding_box":   result["bounding_box"],
                            "mask":           None,
                            "placement_type": placement_type,
                            "logo_scale":     logo_scale,
                            "confidence":     result["confidence"],
                        }],
                        "reasoning": f"Nova mapped: {target_desc} → {selected_label or yolo_prompts[0]}",
                    })
                    hits += 1
            print(f"    Found in {hits}/{len(frame_paths)} frames")

    return all_placements
