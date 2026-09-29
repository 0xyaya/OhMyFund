"""Fetch a consistent 24-hour window for every saved screener mint."""
import concurrent.futures
import collections
import datetime
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
BUNDLE=ROOT/'docs/designs/stocks-data.js'

def clean_candles(payload, mint, start, end):
    if payload.get('mint') != mint:
        raise ValueError('response mint mismatch')
    points={}
    for c in payload.get('candles',[]):
        t=c.get('time'); price=c.get('close')
        if (isinstance(t,(int,float)) and isinstance(price,(int,float))
                and math.isfinite(t) and math.isfinite(price)
                and start <= t <= end and price > 0):
            points[t]={'time':t,'close':price}
    return [points[t] for t in sorted(points)]

def fetch_chart(item,start,end):
    mint,asset_id=item
    query=urllib.parse.urlencode({'mint':mint,'interval':'1H','from':start,'to':end})
    url='https://tokens.xyz/api/v1/assets/'+urllib.parse.quote(asset_id,safe='')+'/ohlcv?'+query
    result={'mint':mint,'chartSource':url,'chartFrom':start,'chartTo':end,'candles':[]}
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url,timeout=20) as response:
                payload=json.load(response)
            result['candles']=clean_candles(payload,mint,start,end)
            result['chartStatus']='available' if len(result['candles'])>=2 else 'insufficient_history'
            break
        except urllib.error.HTTPError as error:
            result['chartStatus']='request_failed';result['chartError']=f'HTTP {error.code}'
            if error.code not in (429,500,502,503,504) or attempt==2:break
            try:delay=float(error.headers.get('Retry-After',2**(attempt+1)))
            except ValueError:delay=2**(attempt+1)
            time.sleep(min(max(delay,1),30))
        except (OSError,ValueError) as error:
            result['chartStatus']='request_failed';result['chartError']=str(error)[:150]
            if attempt==2:break
            time.sleep(2**attempt)
    if result['chartStatus']!='request_failed':result.pop('chartError',None)
    return result

def main():
    bundle=json.loads(BUNDLE.read_text().split('window.STOCK_SNAPSHOT = ',1)[1].rstrip(';\n'))
    items={v['mint']:v['assetId'] for a in bundle['stocks'] for v in a['variants']}
    end=int(time.time());start=end-86400;results={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futures={pool.submit(fetch_chart,item,start,end):item for item in items.items()}
        for f in concurrent.futures.as_completed(futures):
            result=f.result();results[result['mint']]=result
            if len(results)%50==0:print(f"Fetched {len(results)}/{len(items)}",flush=True)
    for a in bundle['stocks']:
        for v in a['variants']:v.update(results[v['mint']])
        a.update(results[a['mint']])
    bundle.update(chartFrom=start,chartTo=end,chartsFetchedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    temporary=BUNDLE.with_suffix('.tmp')
    temporary.write_text('// Generated saved snapshot, not live.\nwindow.STOCK_SNAPSHOT = '+json.dumps(bundle,separators=(',',':')).replace('<','\\u003c')+';\n')
    temporary.replace(BUNDLE)
    report={'fetchedAt':bundle['chartsFetchedAt'],'from':start,'to':end,'totalMints':len(items),'statuses':dict(collections.Counter(v['chartStatus'] for v in results.values())), 'missing':[v for v in results.values() if v['chartStatus']!='available']}
    (ROOT/'data/screener-chart-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='missing'}),flush=True)

if __name__=='__main__':main()
