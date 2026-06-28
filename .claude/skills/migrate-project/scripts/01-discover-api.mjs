import { chromium } from 'playwright-core';
import fs from 'node:fs';
const _env = fs.readFileSync('C:/Users/rayan/Claude/wassell-claude-code/.env.local','utf8');
const API_KEY = (_env.match(/BROWSERBASE_API_KEY\s*=\s*"?([^"\r\n]+)/)||[])[1];
const PROJECT_ID = (_env.match(/BROWSERBASE_PROJECT_ID\s*=\s*"?([^"\r\n]+)/)||[])[1];

const sres = await fetch('https://api.browserbase.com/v1/sessions', {
  method:'POST', headers:{'X-BB-API-Key':API_KEY,'Content-Type':'application/json'},
  body: JSON.stringify({ projectId: PROJECT_ID })
});
const session = await sres.json();
console.error('[bb] session', session.id);
const browser = await chromium.connectOverCDP(session.connectUrl);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();

// capture XHR/fetch to find a units API
const apiCalls = [];
page.on('request', r => {
  const u = r.url();
  if (/almajdiah\.com/.test(u) && !/\.(png|jpg|jpeg|css|js|woff|svg|gif|webp|ico)(\?|$)/.test(u) && r.resourceType()!=='document')
    apiCalls.push(r.method()+' '+u.slice(0,160));
});

await page.goto('https://almajdiah.com/projects/221', { waitUntil:'domcontentloaded', timeout:90000 });
await page.waitForTimeout(3500);

const countCards = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('div.cursor-pointer')).filter(e => (e.textContent||'').includes('الوحدة :')).length);

const before = await countCards();

// scroll to bottom repeatedly, watch count
const series = [before];
for (let i=0;i<12;i++){ await page.mouse.wheel(0, 4000); await page.waitForTimeout(900); series.push(await countCards()); }

// look for load-more / pagination controls + total-count text
const ui = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button,a,li,div[role="button"]'));
  const more = btns.filter(b=>/المزيد|عرض المزيد|تحميل المزيد|load more|التالي|next|الصفحة|page|عرض الكل/i.test((b.textContent||'')+' '+(b.className||'')))
    .map(b=>({tag:b.tagName, txt:(b.textContent||'').replace(/\s+/g,' ').trim().slice(0,30), cls:(b.className||'').toString().slice(0,50)}));
  // pagination numbers
  const pag = Array.from(document.querySelectorAll('.pagination, nav[aria-label], ul')).map(e=>(e.textContent||'').replace(/\s+/g,' ').trim().slice(0,60)).filter(t=>/\d/.test(t)).slice(0,8);
  // total count text e.g. "468"
  const totalMatch = (document.body.innerText.match(/(\d{2,4})\s*(وحدة|شقة|فيلا|عقار)/g)||[]).slice(0,6);
  return { more, pag, totalMatch };
});

await browser.close();
console.log(JSON.stringify({ before, series, ui, apiCalls: [...new Set(apiCalls)].slice(0,40) }, null, 2));
