(() => {
 const passed=[];const check=(name,value)=>{if(!value)throw Error(name);passed.push(name)};
 const reset=()=>{scenario='sample';funds=structuredClone(sampleFunds);stockQuery='';stockCategory='equity';stockSort='name';stockDirection=1;stockPage=0;location.hash='screener';route()};
 reset();
 check('All equities and variants',stockRows.filter(s=>s.category==='equity').length===395&&allStockVariants.length===643&&new Set(stockRows.map(s=>s.assetId)).size===455);
 check('20 rows on first page',document.querySelectorAll('.stock-table tbody tr').length===20);
 document.querySelector('#stock-next').click();check('20 rows on second page',document.querySelectorAll('.stock-table tbody tr').length===20);
 stockQuery='micron';stockPage=0;renderStockResults();check('Company search',filteredStocks().length===1&&filteredStocks()[0].symbol==='MU');
 stockQuery='NKE';renderStockResults();check('Ticker search',filteredStocks().some(s=>s.symbol==='NKE'));
 stockQuery='zzzz-unmatched';renderStockResults();check('No-results recovery',!!document.querySelector('#clear-stock-search'));document.querySelector('#clear-stock-search').click();
 stockSort='price';stockDirection=-1;const ordered=filteredStocks();check('Price sorts descending',ordered.every((s,i)=>!i||!validNumber(s.market?.price)||ordered[i-1].market?.price>=s.market.price));
 const a=stockRows.find(s=>s.category==='equity'&&validNumber(s.market?.price)),price=a.market.price;a.market.price=null;check('Missing price sorts last',!filteredStocks().slice(filteredStocks().indexOf(a)).some(s=>validNumber(s.market?.price)));a.market.price=price;
 check('Missing chart not fabricated',sparkline({candles:[]}).includes('unavailable'));
 const mu=allStockVariants.find(s=>s.symbol==='MU'&&s.issuer==='Backpack Securities'),amc=allStockVariants.find(s=>s.symbol==='AMC'&&s.issuer==='Backpack Securities');
 chooseStock(mu.mint);check('Duplicate fund disabled',document.querySelector('[data-choose-fund="1"]').disabled);check('Fixed fund disabled',document.querySelector('[data-choose-fund="2"]').disabled);
 chooseStock(amc.mint);const before=JSON.stringify(funds[0]);document.querySelector('[data-choose-fund="1"]').click();
 check('Adding opens draft without mutation',JSON.stringify(funds[0])===before&&data().assetMints.includes(amc.mint));
 document.querySelector('#create-dialog [data-close]').click();check('Cancel preserves original',JSON.stringify(funds[0])===before);
 chooseStock(amc.mint);document.querySelector('[data-choose-fund="1"]').click();document.querySelector('#equal-split').click();document.querySelector('#create-next').click();
 check('Save preserves exact mint and schedules',funds[0].assetMints.includes(amc.mint)&&funds[0].plans.length===2);
 chooseStock(mu.mint);document.querySelector('#stock-new-fund').click();document.querySelector('#fund-name').value='Micron basket';document.querySelector('#create-next').click();document.querySelector('#without-schedule').click();check('New fund uses selected mint',funds.at(-1).assetMints.length===1&&funds.at(-1).assetMints[0]===mu.mint);
 funds[0].archived=true;chooseStock(mu.mint);check('Archived fund disabled',document.querySelector('[data-choose-fund="1"]').disabled);document.querySelector('#stock-dialog').close();
 scenario='disconnected';funds=[];chooseStock(amc.mint);check('Disconnected selection retained',pendingStock===amc.mint&&!!document.querySelector('#simulate-connect'));document.querySelector('#simulate-connect').click();document.querySelector('#stock-new-fund').click();check('Demo continuation preserves mint',data().assetMints[0]===amc.mint);document.querySelector('#create-dialog').close();
 check('SOL remains selectable',assetMints[0]==='So11111111111111111111111111111111111111112');
 reset();const multi=stockRows.find(s=>s.category==='equity'&&s.variants.length>1);openStock(multi.mint);const choice=multi.variants.find(v=>v.mint!==multi.mint);document.querySelector('#stock-variant').value=choice.mint;document.querySelector('#stock-variant').dispatchEvent(new Event('change'));check('Version selection switches price and mint',multi.mint===choice.mint&&multi.market===choice.market);document.querySelector('#stock-detail-add').click();document.querySelector('#stock-new-fund').click();check('Chosen issuer mint enters draft',data().assetMints[0]===choice.mint);document.querySelector('#create-dialog').close();reset();for(const [category,count] of [['crypto',31],['etf',25],['commodity',4],['equity',395]]){document.querySelector(`[data-category="${category}"]`).click();check(`Category ${category} count`,filteredStocks().length===count)}check('Removed title and duplicate sort controls',!document.querySelector('.stock-heading')&&!document.querySelector('#stock-sort')&&!document.querySelector('#stock-direction'));reset();return {passed:passed.length,checks:passed};
})()
