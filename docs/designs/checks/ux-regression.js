// Run in the loaded prototype via gstack browse js. Reload afterwards.
(() => {
  const results=[];
  function check(name,condition){if(!condition)throw new Error(name);results.push(name)}
  function input(id,value){const e=document.querySelector(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}))}
  function sample(){const e=document.querySelector('#preview-scenario');e.value='sample';e.dispatchEvent(new Event('change'));}
  sample();
  [1,2,3].forEach(n=>check(`Equal split ${n} totals 100%`,equalWeights(n).reduce((s,w)=>s+Math.round(w*100),0)===10000));
  document.querySelector('#new-fund').click();
  input('#fund-name','Weekend basket');
  document.querySelector('#equal-split').click();
  check('Equal split updates form',document.querySelector('#weight-total').textContent==='Total 100%');
  document.querySelector('.remove-asset').click();
  check('Removing asset shows remainder',document.querySelector('#weight-total').textContent.includes('Remaining'));
  document.querySelector('#equal-split').click();
  document.querySelector('#create-next').click();
  input('#purchase-amount','50');input('#purchase-interval','weekly');
  check('Summary tracks amount and interval',document.querySelector('#schedule-summary').textContent.startsWith('50 USDC, every week'));
  document.querySelector('#create-dialog [data-close]').click();
  document.querySelector('#new-fund').click();input('#fund-name','New basket');document.querySelector('#create-next').click();
  check('Reopening resets summary',document.querySelector('#schedule-summary').textContent.startsWith('20 USDC, every day'));
  document.querySelector('#create-next').click();
  const created=funds.find(f=>f.name==='New basket');
  check('Creation saves plan',created.plans.length===1&&created.plans[0].amount===20);
  document.querySelector('#add-plan').click();input('#plan-amount','30');document.querySelector('#plan-form button[type=submit]').click();
  check('Multiple plans supported',created.plans.length===2);
  const allocation=upcoming();
  check('Shared cash is not reused',allocation.filter(x=>x.funded).reduce((s,x)=>s+x.p.amount,0)<=fixture.cash);
  document.querySelector('.plan-row [data-pause="1"]').click();
  check('Pause affects only selected plan',created.plans[1].paused&&!created.plans[0].paused);
  current=1;detail();
  const before=funds.reduce((s,f)=>s+metrics(f).value,0),receiptCount=fixture.receipts.length;
  document.querySelector('#archive-fund').click();
  document.querySelector('#archive-dialog [data-close]').click();
  check('Cancel archive changes nothing',!funds[0].archived&&!funds[0].plans[0].paused);
  document.querySelector('#archive-fund').click();document.querySelector('#confirm-archive').click();
  check('Archive retains value and history',funds.reduce((s,f)=>s+metrics(f).value,0)===before&&fixture.receipts.length===receiptCount);
  check('Archive stops all fund plans',funds[0].archived&&funds[0].plans.every(p=>p.paused));
  check('Archive has visible recovery path',document.querySelector('.notice a').getAttribute('href')==='#fund-1');
  sample();
  return {passed:results.length,results};
})()
