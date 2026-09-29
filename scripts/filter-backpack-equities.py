"""Filter the saved Tokens equity snapshot. No API key or network required."""
import csv
import json
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/tokens-equity.json'
ISSUER = 'Backpack Securities'


def backpack_evidence(variant):
    # An explicit conflicting issuer must never be overridden by a name or logo.
    issuer = variant.get('issuer')
    if issuer and issuer != ISSUER:
        return None
    if issuer == ISSUER:
        return 'issuer'
    if variant.get('label') == ISSUER or ISSUER in variant.get('tags', []):
        return 'provider_label_or_tag'
    # Some Tokens entries omit issuer/label metadata. Require two corroborating
    # fields, not a name substring alone. This is attribution by Tokens metadata,
    # not independent on-chain mint verification.
    market = variant.get('market') or {}
    logo = urlparse(market.get('logoURI') or '')
    if (variant.get('name', '').endswith(' - Backpack Securities')
            and logo.scheme == 'https'
            and logo.hostname in {'backpack.exchange', 'metadata.backpack.exchange'}):
        return 'token_name_and_backpack_logo'
    return None


def main():
    snapshot = json.loads(SOURCE.read_text())
    selected, excluded = [], []
    for asset in snapshot['assets']:
        if asset.get('category') != 'equity':
            continue
        matches = {}
        for variant in asset.get('variants', []):
            evidence = backpack_evidence(variant)
            if evidence and variant.get('kind') == 'tokenized_equity' and variant.get('mint'):
                matches[variant['mint']] = (variant, evidence)
        if len(matches) != 1:
            excluded.append({'assetId': asset['assetId'], 'reason': 'no_backpack_match' if not matches else 'ambiguous_backpack_mints', 'mints': list(matches)})
            continue
        variant, evidence = next(iter(matches.values()))
        selected.append({
            'assetId': asset['assetId'], 'name': asset.get('name'),
            'symbol': variant.get('symbol') or asset.get('symbol'),
            'category': 'equity', 'mint': variant['mint'],
            'issuer': ISSUER, 'sourceIssuer': variant.get('issuer'),
            'matchEvidence': evidence, 'variantId': variant.get('variantId'),
            'tokenName': variant.get('name'), 'advisory': variant.get('advisory'),
            'market': variant.get('market'),
        })
    selected.sort(key=lambda row: (row['symbol'] or '', row['assetId']))
    assert len({row['assetId'] for row in selected}) == len(selected)
    assert len({row['mint'] for row in selected}) == len(selected)
    payload = {
        'source': snapshot['source'], 'sourceRetrievedAt': snapshot['retrievedAt'],
        'filter': 'category=equity; exactly one Backpack-attributed tokenized_equity variant',
        'attribution': 'Tokens metadata; issuer omissions use label/tag or exact name suffix plus Backpack-hosted logo. Not independently mint-verified.',
        'count': len(selected), 'assets': selected, 'excluded': excluded,
    }
    (ROOT / 'data/backpack-equities.json').write_text(json.dumps(payload, indent=2) + '\n')
    fields = ['symbol', 'name', 'assetId', 'mint', 'issuer', 'sourceIssuer', 'matchEvidence', 'variantId']
    with (ROOT / 'data/backpack-equities.csv').open('w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(selected)
    lines = ['# Backpack Securities equities', '',
             f"Source snapshot: {snapshot['retrievedAt']}", '',
             f'{len(selected)} equities, one Backpack-attributed mint each. Other issuers are excluded; no fallback to the primary variant.', '',
             'Attribution follows Tokens metadata. Missing issuer fields use exact provider labels/tags, or the exact token-name suffix plus a Backpack-hosted logo. This is not independent mint verification. Match evidence is recorded in JSON and CSV.', '',
             '| Ticker | Company | Mint |', '| --- | --- | --- |']
    lines += [f"| {r['symbol']} | {r['name']} | `{r['mint']}` |" for r in selected]
    (ROOT / 'data/backpack-equities.md').write_text('\n'.join(lines) + '\n')
    print(json.dumps({'selected': len(selected), 'excluded': len(excluded), 'ambiguous': sum(x['reason']=='ambiguous_backpack_mints' for x in excluded), 'tickers': [r['symbol'] for r in selected]}))


if __name__ == '__main__':
    main()
