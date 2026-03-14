import os

# AWS
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")

# Model IDs
NOVA_MODEL_ID        = os.getenv("NOVA_MODEL_ID",        "amazon.nova-pro-v1:0")
NOVA_CANVAS_MODEL_ID = os.getenv("NOVA_CANVAS_MODEL_ID", "amazon.nova-canvas-v1:0")

# Processing
FRAME_EXTRACTION_FPS      = int(os.getenv("FRAME_EXTRACTION_FPS",      "5"))
MAX_PLACEMENTS_PER_VIDEO  = int(os.getenv("MAX_PLACEMENTS_PER_VIDEO",  "5"))
STRATEGIST_MIN_CONFIDENCE = float(os.getenv("STRATEGIST_MIN_CONFIDENCE", "0.7"))

# Detector: "rekognition" or "yolo_world"
DETECTOR = os.getenv("DETECTOR", "rekognition")

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# S3 / DynamoDB
S3_BUCKET      = os.getenv("S3_BUCKET",      "video-ad-placer-bucket")
ADS_TABLE_NAME = os.getenv("ADS_TABLE_NAME", "video-ad-placer-ads")
