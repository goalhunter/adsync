"""
Database Tool - Fetches available ads from DynamoDB
"""
import os
import boto3
from typing import List, Dict, Any
from config import ADS_TABLE_NAME, AWS_REGION

dynamodb = boto3.resource('dynamodb', region_name=AWS_REGION)


def get_available_ads() -> List[Dict[str, Any]]:
    """Fetch all available ads from DynamoDB."""
    table = dynamodb.Table(ADS_TABLE_NAME)
    response = table.scan()
    ads = response.get('Items', [])
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        ads.extend(response.get('Items', []))
    return ads
