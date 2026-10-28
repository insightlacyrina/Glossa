import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const out = new URL('.', import.meta.url);
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
try {
const page=await browser.newPage({viewport:{width:1150,height:650},deviceScaleFactor:1});
await page.goto('http://127.0.0.1:5173');
const data=await page.evaluate(async()=>{
const {strokeOutline}=await import('/src/ink.ts');
const points=[{x:15,y:30,pressure:0},{x:65,y:30,pressure:.2},{x:80,y:60,pressure:1},{x:40,y:80,pressure:.8},{x:20,y:50,pressure:.1}].map((p,i)=>({...p,tiltX:0,tiltY:0,time:i}));
const old=points.slice(1).map((p,i)=>`<path d="M${points[i].x},${points[i].y}L${p.x},${p.y}" fill="none" stroke="#39353b" stroke-linecap="round" stroke-width="${5*(.4+(p.pressure+points[i].pressure)/2*1.2)}"/>`).join('');
const current=`<path d="${strokeOutline(points,5)}" fill="#39353b" fill-rule="nonzero"/>`;
const svg=c=>`<svg xmlns="http://www.w3.org/2000/svg" width="110" height="110">${c}</svg>`;
async function raster(c,scale=1){const img=new Image();img.src='data:image/svg+xml;base64,'+btoa(svg(c));await img.decode();const cv=document.createElement('canvas');cv.width=cv.height=110*scale;const ctx=cv.getContext('2d');ctx.scale(scale,scale);ctx.drawImage(img,0,0);return ctx.getImageData(0,0,cv.width,cv.height).data;}
const results=[];let diffSvg='';
for(const scale of [1,2,4,8]){const a=await raster(old,scale),b=await raster(current,scale);let oldArea=0,newArea=0,difference=0,alphaAbs=0,maxAlpha=0,interior=0;let bounds=[Infinity,Infinity,-Infinity,-Infinity];for(let i=3;i<a.length;i+=4){const before=a[i]>127,after=b[i]>127;oldArea+=before;newArea+=after;difference+=before!==after;alphaAbs+=Math.abs(a[i]-b[i]);maxAlpha=Math.max(maxAlpha,Math.abs(a[i]-b[i]));if(Math.abs(a[i]-b[i])>0){const x=((i-3)/4)%(110*scale),y=Math.floor((i-3)/4/(110*scale));bounds=[Math.min(bounds[0],x),Math.min(bounds[1],y),Math.max(bounds[2],x),Math.max(bounds[3],y)];if(a[i]===255&&b[i]===0||b[i]===255&&a[i]===0)interior++;if(scale===1)diffSvg+=`<rect x="${x}" y="${y}" width="1" height="1" fill="${before!==after?'#e33':'#ccc'}"/>`;}}results.push({scale,oldArea,newArea,difference,relativeContourDifference:difference/oldArea,alphaAbsoluteEquivalentPixels:alphaAbs/255/(scale*scale),maxAlphaDifference:maxAlpha,fullyOpaqueVsTransparentPixels:interior,bounds});}
return {old:svg(old),current:svg(current),diff:svg(diffSvg),results};});
for(const key of ['old','current','diff'])await writeFile(new URL(key+'.svg',out),data[key]);
await writeFile(new URL('metrics.json',out),JSON.stringify({chrome:browser.version(),...data,old:undefined,current:undefined,diff:undefined},null,2));
await page.setContent(`<style>body{font:16px system-ui;background:white;padding:24px}section{display:flex;gap:35px}article{width:330px}img{width:330px;height:330px;image-rendering:pixelated;border:1px solid #ddd}.native img{width:110px;height:110px}</style><h1>Ink contour comparison · Chrome ${browser.version()}</h1><section>${['old','current','diff'].map(k=>`<article><h2>${k}</h2><img src="data:image/svg+xml;base64,${Buffer.from(data[k]).toString('base64')}"><div class="native"><img src="data:image/svg+xml;base64,${Buffer.from(data[k]).toString('base64')}"></div></article>`).join('')}</section><p>3× nearest-neighbor above; 1× below. Diff: red = threshold disagreement; gray = alpha-only difference.</p>`);
await page.screenshot({path:new URL('comparison.png',out).pathname});
console.log(JSON.stringify(data.results));
}finally{await browser.close()}
