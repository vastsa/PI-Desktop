"""Bounded S3 test administration. Credentials arrive only via stdin JSON."""
import json
import re
import sys

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def run(data):
    connection = data["connection"]
    prefix = connection["prefix"]
    if not re.fullmatch(r"pi-desktop-tests/s3-config-sync-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", prefix):
        raise ValueError("unsafe test prefix")
    prefix += "/"
    client = boto3.client(
        "s3", endpoint_url=connection["endpoint"], region_name=connection["region"],
        aws_access_key_id=connection["accessKeyId"],
        aws_secret_access_key=connection["secretAccessKey"],
        aws_session_token=connection.get("sessionToken") or None,
        config=Config(signature_version="s3v4", connect_timeout=10, read_timeout=30,
                      retries={"max_attempts": 1},
                      s3={"addressing_style": "path" if connection["pathStyle"] else "virtual"}),
    )
    bucket = connection["bucket"]
    versioned = client.get_bucket_versioning(Bucket=bucket).get("Status") in ("Enabled", "Suspended")

    def safe_key(key):
        if not key.startswith(prefix):
            raise ValueError("out-of-scope object")
        relative = key[len(prefix):]
        if not re.fullmatch(r"header|probe/[0-9a-f-]{36}|vault/[0-9a-f-]{36}/(?:head|backup-head|(?:revisions|objects)/[a-zA-Z0-9_.:-]{1,128})", relative):
            raise ValueError("unexpected object in test namespace")
        return key

    def inventory():
        keys = []
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            keys.extend(safe_key(item["Key"]) for item in page.get("Contents", []))
            if len(keys) > 2000:
                raise ValueError("test inventory limit exceeded")
        return sorted(keys)

    def versions():
        if not versioned:
            return []
        entries = []
        for page in client.get_paginator("list_object_versions").paginate(Bucket=bucket, Prefix=prefix):
            for item in page.get("Versions", []) + page.get("DeleteMarkers", []):
                entries.append({"Key": safe_key(item["Key"]), "VersionId": item["VersionId"]})
            if len(entries) > 10000:
                raise ValueError("test version limit exceeded")
        return entries

    operation = data["operation"]
    if operation == "prepare":
        if inventory() or versions():
            raise ValueError("test namespace is not empty")
        return {"empty": True, "versioned": versioned}
    if operation == "inventory":
        return {"keys": inventory()}
    if operation == "inspect":
        keys = inventory()
        if not keys:
            raise ValueError("expected encrypted objects")
        total = 0
        markers = [value.encode() for value in data["markers"] if value]
        for key in keys:
            response = client.get_object(Bucket=bucket, Key=key)
            with response["Body"] as stream:
                body = stream.read(64 * 1024 * 1024 + 1)
            total += len(body)
            if len(body) > 64 * 1024 * 1024 or total > 256 * 1024 * 1024:
                raise ValueError("inspection limit exceeded")
            if any(marker in body for marker in markers):
                raise ValueError("remote plaintext leaked")
        return {"objects": len(keys), "ciphertext": True, "versioned": versioned}
    if operation == "cleanup":
        if data.get("ownedEmptyNamespace") is not True:
            raise ValueError("cleanup requires initial empty namespace verification")
        # Hosts have stopped. Capture one exact inventory, then delete only it.
        entries = versions() if versioned else [{"Key": key} for key in inventory()]
        for entry in entries:
            client.delete_object(Bucket=bucket, **entry)
        remaining = len(inventory())
        remaining_versions = len(versions())
        if remaining or remaining_versions:
            raise ValueError("test cleanup incomplete")
        return {"deleted": len(entries), "remaining": remaining, "versions": remaining_versions}
    raise ValueError("unsupported administration operation")


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": run(json.load(sys.stdin))}))
    except ClientError as error:
        # Never serialize messages, URLs, headers, request parameters or credentials.
        print(json.dumps({"ok": False, "kind": "S3Request", "status": error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")}))
        sys.exit(1)
    except Exception as error:
        print(json.dumps({"ok": False, "kind": type(error).__name__}))
        sys.exit(1)
