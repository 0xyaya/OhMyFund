// Local card export. X composer is opened only when the user follows its link.
async function openFundShare(f){
 let dialog=document.querySelector('#share-dialog');
 if(!dialog){
  dialog=document.createElement('dialog');dialog.id='share-dialog';dialog.setAttribute('aria-labelledby','share-title');
  dialog.innerHTML='<div class="row"><h2 id="share-title">Share fund</h2><button class="icon" aria-label="Close share">×</button></div><p class="muted">Share your basket and its target weights.</p><canvas id="share-card" width="1200" height="900" role="img"></canvas><p class="small muted">Download the card, then attach it to your post on X.</p><div class="dialog-actions"><a class="button" id="share-download">Download PNG</a><a class="button primary" id="share-x" target="_blank" rel="noopener noreferrer">Open in X ↗</a></div><p class="small muted">Local preview · no public fund link yet.</p>';
  document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.close();
 }
 await document.fonts.ready;
 const canvas=dialog.querySelector('canvas'),ctx=canvas.getContext('2d');
 const rows=f.assets.map((a,i)=>({name:assets[a].split(' ·')[0],issuer:typeof assetIssuers!=='undefined'?assetIssuers[a]:'Solana',weight:f.weights[i]}));
 canvas.height=390+Math.max(3,rows.length)*100;
 ctx.fillStyle='#fafafa';ctx.fillRect(0,0,canvas.width,canvas.height);
 const text=(value,x,y,size=28,color='#202124',weight=400)=>{ctx.fillStyle=color;ctx.font=`${weight} ${size}px Inter, sans-serif`;ctx.fillText(value,x,y)};
 const fit=(value,max)=>{let out=value;while(ctx.measureText(out).width>max&&out.length>1)out=out.slice(0,-1);return out===value?out:out.slice(0,-1)+'…'};
 text('m.  ohmyfund',64,80,32,'#202124',600);
 text('BASKET · DESIGN PREVIEW',64,145,20,'#63666d');
 ctx.font='550 54px Inter, sans-serif';const title=fit(f.name,1060);text(title,64,216,54,'#202124',550);
 text(f.archived?'Archived basket':f.mutable?'Editable basket':'Fixed basket',64,259,24,'#63666d');
 text('Target allocation',64,321,24,'#63666d');
 rows.forEach((r,i)=>{const y=378+i*100;ctx.strokeStyle='#e3e5e8';ctx.beginPath();ctx.moveTo(64,y-30);ctx.lineTo(1136,y-30);ctx.stroke();ctx.font='500 30px Inter, sans-serif';text(fit(r.name,830),64,y+10,30,'#202124',500);ctx.font='400 20px Inter, sans-serif';text(fit(r.issuer,830),64,y+40,20,'#63666d');ctx.textAlign='right';text(`${number(r.weight)}%`,1136,y+10,32,'#202124',500);ctx.textAlign='left'});
 text('My basket on Solana',64,canvas.height-40,22,'#63666d');
 canvas.setAttribute('aria-label',`${f.name}. Target weights: ${rows.map(r=>`${r.name} ${number(r.weight)}%`).join(', ')}. Design preview.`);
 const download=dialog.querySelector('#share-download');download.href=canvas.toDataURL('image/png');download.download=`ohmyfund-${f.name.replace(/[^a-z0-9]+/gi,'-').slice(0,48)||'basket'}.png`;
 const draft=`My ${f.archived?'archived ':''}basket on Solana: ${f.name}\n\n${rows.slice(0,3).map(r=>`${r.name} ${number(r.weight)}%`).join(' · ')}${rows.length>3?' · more in the card':''}\n\nBuilt with OhMyFund · design preview.`;
 dialog.querySelector('#share-x').href='https://twitter.com/intent/tweet?'+new URLSearchParams({text:draft});
 dialog.showModal();
}
