// Stocks use a saved Tokens snapshot; fund changes remain in-memory preview drafts.
const stockSnapshot=window.STOCK_SNAPSHOT;
const stockRows=stockSnapshot?.stocks||[];
const assetMints=['So11111111111111111111111111111111111111112'];
const allStockVariants=stockRows.flatMap(s=>s.variants);
const assetIssuers=['Solana'];
for(const stock of allStockVariants){
 let index=assetMints.indexOf(stock.mint);
 if(index<0){
  index=stock.issuer==='Backpack Securities'&&stock.symbol==='MU'?1:stock.issuer==='Backpack Securities'&&stock.symbol==='NKE'?2:assets.length;
  assets[index]=`${stock.tokenSymbol||stock.symbol} · ${stock.issuer}`;
  assetMints[index]=stock.mint;assetIssuers[index]=stock.issuer;
 }
 stock.assetIndex=index;
}
for(const stock of stockRows)stock.assetIndex=assetMints.indexOf(stock.mint);
for(const fund of funds)fund.assetMints=fund.assets.map(i=>assetMints[i]);
let stockCategory='crypto';
const screenerCategories=[['crypto','Crypto'],['etf','ETFs'],['commodity','Metals'],['equity','Stocks']];
let stockQuery='',stockSort='volume24hUSD',stockDirection=-1,stockPage=0,pendingStock=null;
const pageSize=20;
const validNumber=n=>typeof n==='number'&&Number.isFinite(n);
const compactMoney=n=>validNumber(n)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}).format(n):'—';
const stockPrice=n=>validNumber(n)?(n>0&&n<1?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:4}).format(n):money(n)):'—';
const stockChange=n=>validNumber(n)?`${n>=0?'+':'−'}${number(Math.abs(n))}%`:'—';
function stockValue(s,key){return key==='name'?s.name.toLowerCase():s.market?.[key]}
function filteredStocks(){return stockRows.filter(s=>s.category===stockCategory).filter(s=>`${s.name} ${s.symbol}`.toLowerCase().includes(stockQuery.toLowerCase().trim())).sort((a,b)=>{
 const av=stockValue(a,stockSort),bv=stockValue(b,stockSort);
 if(stockSort!=='name'){if(!validNumber(av)&&!validNumber(bv))return a.symbol.localeCompare(b.symbol);if(!validNumber(av))return 1;if(!validNumber(bv))return -1;}
 return stockDirection*(typeof av==='string'?av.localeCompare(bv):av-bv)||a.symbol.localeCompare(b.symbol);
})}
function sparkline(s,large=false){
 const points=s.candles||[];if(points.length<2){const reason=s.chartStatus==='request_failed'?'Chart request failed':s.chartStatus==='insufficient_history'?'Not enough trading history in the last 24 hours':'Chart not yet fetched';return `<span class="chart-missing" title="${reason}">—<span class="sr-only">Chart unavailable: ${reason}</span></span>`;}
 const values=points.map(p=>p.close),min=Math.min(...values),max=Math.max(...values),range=max-min||1;
 // Shared time window; split paths across missing hourly candles rather than bridge gaps.
 const paths=[];let segment=[];
 points.forEach((p,i)=>{if(i&&p.time-points[i-1].time>5400){paths.push(segment);segment=[]}segment.push(`${4+((p.time-stockSnapshot.chartFrom)/(stockSnapshot.chartTo-stockSnapshot.chartFrom))*152},${44-(p.close-min)/range*36}`)});paths.push(segment);
 return `<svg class="sparkline ${points.at(-1).close>=points[0].close?"trend-up":"trend-down"} ${large?'large':''}" viewBox="0 0 160 52" role="img" aria-label="${escapeHTML(s.symbol)} saved 24-hour price trend"><title>Hourly selected-mint prices. Each chart has its own price scale.</title>${paths.filter(p=>p.length>1).map(p=>`<polyline points="${p.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.7"/>`).join('')}</svg>`;
}
function renderStocks(){
 const section=$('#stocks');
 if(!stockSnapshot){section.innerHTML='<div class="page-head"><h1>Screener unavailable</h1><p>The saved catalog could not load. Reload to retry.</p><button onclick="location.reload()">Reload</button></div>';return}
 section.innerHTML=`<h1 class="sr-only">Screener</h1><div class="stock-toolbar"><label class="stock-search"><span class="sr-only">Search assets</span><span class="search-glyph" aria-hidden="true">⌕</span><input id="stock-search" type="search" placeholder="Search by name or ticker" value="${escapeHTML(stockQuery)}"></label></div><div class="category-tabs" role="group" aria-label="Asset category">${screenerCategories.map(([id,label])=>`<button data-category="${id}" aria-pressed="${stockCategory===id}">${label}</button>`).join('')}</div><p id="stock-count" class="sr-only" aria-live="polite"></p><div id="stock-results"></div><div class="stock-pagination"><button id="stock-prev">Previous</button><span id="stock-page" class="small"></span><button id="stock-next">Next</button></div><p class="small muted">Saved Tokens data · Not live. Prices and charts refer to the selected mint.</p>`;
 document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{stockCategory=b.dataset.category;stockPage=0;document.querySelectorAll('[data-category]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));renderStockResults()});
 $('#stock-search').oninput=e=>{stockQuery=e.target.value;stockPage=0;renderStockResults()};
 $('#stock-prev').onclick=()=>{stockPage--;renderStockResults();$('#stock-results').scrollIntoView({block:'start'})};$('#stock-next').onclick=()=>{stockPage++;renderStockResults();$('#stock-results').scrollIntoView({block:'start'})};
 renderStockResults();
}
function renderStockResults(){
 const all=filteredStocks();stockPage=Math.max(0,Math.min(stockPage,Math.ceil(all.length/pageSize)-1));const shown=all.slice(stockPage*pageSize,(stockPage+1)*pageSize);
 $('#stock-count').textContent=`${all.length} ${all.length===1?'asset':'assets'}${stockQuery?' matching your search':''}`;
 const head=(label,key)=>`<th scope="col" ${stockSort===key?`aria-sort="${stockDirection===1?'ascending':'descending'}"`:''}><button class="column-sort" data-sort="${key}">${label==='24h change'?'<span class="desktop-label">24h change</span><span class="mobile-label">24h</span>':label}<span aria-hidden="true">${stockSort===key?(stockDirection===1?'↑':'↓'):'↕'}</span></button></th>`;
 $('#stock-results').innerHTML=shown.length?`<table class="stock-table"><caption class="sr-only">Asset screener market snapshot</caption><thead><tr>${head('Token name','name')}${head('Price','price')}${head('24h change','priceChange24hPercent')}<th scope="col" class="stock-chart">Last 24h</th><th scope="col" class="stock-volume" ${stockSort==='volume24hUSD'?`aria-sort="${stockDirection===1?'ascending':'descending'}"`:''}><button class="column-sort" data-sort="volume24hUSD">24h volume <span aria-hidden="true">↕</span></button></th><th scope="col" class="stock-action"><span class="sr-only">Add to fund</span></th></tr></thead><tbody>${shown.map(s=>`<tr><td><button class="stock-identity" data-stock="${s.mint}"><span class="stock-avatar" aria-hidden="true">${s.localLogo?`<img src="${escapeHTML(s.localLogo)}" alt="" width="28" height="28">`:escapeHTML(s.symbol.slice(0,2))}</span><span class="stock-title"><span class="stock-name-line"><strong title="${escapeHTML(s.name)}">${escapeHTML(s.name)}</strong><span class="stock-ticker">${escapeHTML(s.symbol)}</span></span><span class="stock-issuer">${escapeHTML(s.issuer)}${s.variants.length>1?` · ${s.variants.length} versions`:""}</span></span></button></td><td class="numeric">${stockPrice(s.market?.price)}</td><td class="numeric ${s.market?.priceChange24hPercent>=0?'positive':'negative'}">${stockChange(s.market?.priceChange24hPercent)}</td><td class="stock-chart">${sparkline(s)}</td><td class="stock-volume numeric">${compactMoney(s.market?.volume24hUSD)}</td><td class="stock-action"><button data-add-stock="${s.mint}" aria-label="Add ${escapeHTML(s.symbol)} to fund" title="Add to fund">+</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty"><h2>No matching assets</h2><p class="muted">Try a company name or ticker.</p><button id="clear-stock-search">Clear search</button></div>';
 $('#clear-stock-search')?.addEventListener('click',()=>{stockQuery='';$('#stock-search').value='';renderStockResults();$('#stock-search').focus()});
 $('#stock-prev').disabled=stockPage===0;$('#stock-next').disabled=(stockPage+1)*pageSize>=all.length;$('#stock-page').textContent=all.length?`${stockPage*pageSize+1}–${Math.min((stockPage+1)*pageSize,all.length)} of ${all.length}`:'0 assets';
 document.querySelectorAll('[data-sort]').forEach(b=>b.onclick=()=>{if(stockSort===b.dataset.sort)stockDirection*=-1;else{stockSort=b.dataset.sort;stockDirection=stockSort==='name'?1:-1}stockPage=0;renderStockResults()});
 document.querySelectorAll('[data-stock]').forEach(b=>b.onclick=()=>openStock(b.dataset.stock));document.querySelectorAll('[data-add-stock]').forEach(b=>b.onclick=()=>chooseStock(b.dataset.addStock));
}
function stockDialog(title,content){
 let d=$('#stock-dialog');if(!d){d=document.createElement('dialog');d.id='stock-dialog';d.setAttribute('aria-labelledby','stock-dialog-title');document.body.append(d);d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}})}
 d.innerHTML=`<div class="row"><h2 id="stock-dialog-title">${escapeHTML(title)}</h2><button class="icon" id="close-stock" aria-label="Close stock details">×</button></div>${content}`;$('#close-stock').onclick=()=>d.close();if(!d.open)d.showModal();return d;
}
function openStock(mint){const s=stockRows.find(s=>s.mint===mint);if(!s)return;
 stockDialog(s.symbol,`<p>${escapeHTML(s.name)}</p><label for="stock-variant">Token version / issuer</label><select id="stock-variant">${s.variants.map(v=>`<option value="${v.mint}" ${v.mint===s.mint?"selected":""}>${escapeHTML(v.issuer)} · ${escapeHTML(v.tokenSymbol||v.symbol)} · ${v.mint.slice(0,4)}…${v.mint.slice(-4)}</option>`).join("")}</select><div class="balance medium">${stockPrice(s.market?.price)}</div><p>${stockChange(s.market?.priceChange24hPercent)} over 24 hours</p>${sparkline(s,true)}<dl class="stock-facts"><dt>24h token volume</dt><dd>${compactMoney(s.market?.volume24hUSD)}</dd><dt>Token liquidity</dt><dd>${stockPrice(s.market?.liquidity)}</dd><dt>Market data fetched</dt><dd>${s.market?.lastFetchedAt?escapeHTML(new Date(s.market.lastFetchedAt).toLocaleString()):'Unavailable'}</dd></dl><p class="small muted">Saved data, not live. Latest trade: ${s.market?.lastTradeAt?escapeHTML(new Date(s.market.lastTradeAt).toLocaleString()):'unknown'}. Chart ends ${escapeHTML(new Date(stockSnapshot.chartTo*1000).toLocaleString())}.</p><button class="primary" id="stock-detail-add">Add to fund</button><details><summary>Token details</summary><p class="small">Provider metadata: ${escapeHTML(s.matchEvidence.replaceAll('_',' '))}</p><p class="mint-address">${s.mint}</p><a class="button" href="https://solscan.io/token/${s.mint}" target="_blank" rel="noopener noreferrer">View mint ↗</a></details>`);
 $('#stock-variant').onchange=e=>{const v=s.variants.find(v=>v.mint===e.target.value);Object.assign(s,v);openStock(s.mint);renderStockResults()};
 $('#stock-detail-add').onclick=()=>chooseStock(s.mint);
}
function chooseStock(mint){const s=allStockVariants.find(s=>s.mint===mint);if(!s)return;pendingStock=mint;
 if(scenario==='disconnected'){
 stockDialog(`Add ${s.symbol}`,`<p>Connect your wallet to create or update a basket.</p><p class="small muted">This prototype can simulate the next step. No real wallet will connect.</p><button class="primary" id="simulate-connect">Continue in demo</button>`);
 $('#simulate-connect').onclick=()=>{scenario='empty';$('#preview-scenario').value='empty';$('#sample-label').textContent='Simulated connection · no real wallet';chooseStock(pendingStock)};return;
 }
 stockDialog(`Add ${s.symbol} to a fund`,`<p class="muted">Selected version: ${escapeHTML(s.issuer)}. Review the basket weights before saving.</p><div class="fund-choices">${funds.map(f=>{const reason=f.archived?'Archived':!f.mutable?'Fixed basket':f.assets.includes(s.assetIndex)?'Already in this fund':f.assets.length>=8?'Basket has 8 assets':'';return `<button data-choose-fund="${f.id}" ${reason?'disabled':''}><strong>${escapeHTML(f.name)}</strong><span class="small muted">${reason||'Edit basket weights'}</span></button>`}).join('')}</div><button class="primary" id="stock-new-fund">Create new fund</button>`);
 document.querySelectorAll('[data-choose-fund]').forEach(b=>b.onclick=()=>stockDraft(s,funds.find(f=>f.id===+b.dataset.chooseFund)));$('#stock-new-fund').onclick=()=>stockDraft(s,null);
}
function stockDraft(s,f){
 if(f&&(f.archived||!f.mutable||f.assets.includes(s.assetIndex)||f.assets.length>=8))return;
 $('#stock-dialog').close();openCreate(f);
 assetFields(f?{assets:[...f.assets,s.assetIndex],weights:[...f.weights,0]}:{assets:[s.assetIndex],weights:[100]});
 $('#allocation-error').textContent=f?'Set a weight for the new stock, or choose Equal split.':'';pendingStock=null;
}
// Saved basket identity includes exact mints; indices remain an internal preview lookup.
const originalData=data;data=function(){const d=originalData();return {...d,assetMints:d.assets.map(i=>assetMints[i])}};
const originalValidate=validate;validate=function(){const d=data();if(!d.assets.length||d.assets.length>8||d.assets.some(i=>!assetMints[i]))return 'Choose between 1 and 8 supported assets.';return originalValidate()};
const originalUpdateAssets=updateAssets;updateAssets=function(){originalUpdateAssets();const full=document.querySelectorAll('.asset-input').length>=8;$('#add-asset').disabled=full;$('#add-asset').hidden=full};
const previousRoute=route;route=function(){
 if(location.hash==='#screener'||location.hash==='#stocks'){
 ['portfolio','activity','fund-detail'].forEach(id=>$('#'+id).hidden=true);$('#stocks').hidden=false;
 ['nav-portfolio','nav-activity'].forEach(id=>$('#'+id).removeAttribute('aria-current'));$('#nav-stocks').setAttribute('aria-current','page');renderStocks();$('#wallet-open').textContent=scenario==='disconnected'?'Connect wallet':'Wallet';
 }else{$('#stocks').hidden=true;$('#nav-stocks').removeAttribute('aria-current');previousRoute()}
};
route();
