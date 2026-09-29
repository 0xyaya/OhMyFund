"""Export the approved preview's saved mint charts as API-readable JSON."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/designs/stocks-data.js"
TARGET = ROOT / "data/screener-charts.json"
LOGO_TARGET = ROOT / "apps/web/app/screener/logos.json"
PREFIX = "window.STOCK_SNAPSHOT = "

payload = SOURCE.read_text()
if PREFIX not in payload:
    raise ValueError("Saved screener bundle is missing its JSON payload")
snapshot = json.loads(payload.split(PREFIX, 1)[1].rstrip(";\n"))
charts = {}
logos = {}
for asset in snapshot["stocks"]:
    if asset.get("localLogo"):
        logos[asset["mint"]] = "/" + asset["localLogo"]
    for variant in asset["variants"]:
        mint = variant["mint"]
        entry = {
            "status": variant.get("chartStatus", "not_fetched"),
            "from": variant.get("chartFrom"),
            "to": variant.get("chartTo"),
            "candles": variant.get("candles", []),
        }
        previous = charts.get(mint)
        if previous is not None and previous != entry:
            raise ValueError(f"Conflicting chart records for {mint}")
        charts[mint] = entry

TARGET.write_text(json.dumps({"chartsFetchedAt": snapshot.get("chartsFetchedAt"), "charts": charts}, separators=(",", ":")) + "\n")
print(f"Exported {len(charts)} mint charts to {TARGET}")
LOGO_TARGET.write_text(json.dumps(logos, separators=(",", ":")) + "\n")
print(f"Exported {len(logos)} local logo references to {LOGO_TARGET}")
