import { chromium } from 'playwright-core';
import fs from 'node:fs';
const _env = fs.readFileSync('C:/Users/rayan/Claude/wassell-claude-code/.env.local','utf8');
const API_KEY=(_env.match(/BROWSERBASE_API_KEY\s*=\s*"?([^"\r\n]+)/)||[])[1];
const PROJECT_ID=(_env.match(/BROWSERBASE_PROJECT_ID\s*=\s*"?([^"\r\n]+)/)||[])[1];
const s=await(await fetch('https://api.browserbase.com/v1/sessions',{method:'POST',headers:{'X-BB-API-Key':API_KEY,'Content-Type':'application/json'},body:JSON.stringify({projectId:PROJECT_ID})})).json();
console.error('[bb] session',s.id);
const browser=await chromium.connectOverCDP(s.connectUrl);
const ctx=browser.contexts()[0]; const page=ctx.pages()[0]||await ctx.newPage();
await page.goto('https://almajdiah.com/projects/229',{waitUntil:'domcontentloaded',timeout:90000});
await page.waitForTimeout(4000);
for(let i=0;i<8;i++){ await page.mouse.wheel(0,3000); await page.waitForTimeout(700); }
await page.waitForTimeout(1500);
const out=await page.evaluate(()=>{
  const text=document.body.innerText;
  const links=Array.from(document.querySelectorAll('a[href]')).map(a=>({t:(a.textContent||'').replace(/\s+/g,' ').trim().slice(0,40), href:a.href})).filter(l=>/drive\.google|maps|\.pdf|goo\.gl|brochure/i.test(l.href)||/بروشور|الوصول لموقع|الموقع/.test(l.t));
  // headings/sections
  const heads=Array.from(document.querySelectorAll('h1,h2,h3,h4,.title,[class*=title]')).map(h=>(h.textContent||'').replace(/\s+/g,' ').trim()).filter(t=>t&&t.length<60).slice(0,60);
  return {text, links, heads};
});
await browser.close();
fs.writeFileSync('page_229.txt', out.text);
fs.writeFileSync('page_229_meta.json', JSON.stringify({links:out.links, heads:out.heads}, null, 1));
console.log('TEXT LEN', out.text.length);
console.log('LINKS:', JSON.stringify(out.links,null,1));
console.log('HEADINGS:', JSON.stringify(out.heads,null,1));
