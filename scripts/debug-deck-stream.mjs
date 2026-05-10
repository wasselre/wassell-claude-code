// Replay the user's brief via streaming + finalMessage and dump everything.
// Goal: figure out why outputFileId is null on the production endpoint.

import Anthropic from "@anthropic-ai/sdk";

const SKILL_ID = "skill_01WfZySZ4829ynH3zaLB9nao";
const BETAS = ["skills-2025-10-02", "code-execution-2025-08-25", "files-api-2025-04-14"];

const SYSTEM = `You are building a Wassel Real Estate brand-compliant PowerPoint per the user's brief.
The 'wassel-general-ppt' skill is loaded — read its SKILL.md and use scripts/wassel_chrome.py.
Compose a custom Python build script and save the output to /mnt/user-data/outputs/<slug>.pptx.
Reply with one short sentence describing what you built.`;

// User's actual brief (copied from the failed record)
const BRIEF = `الملف التعريفي
1. الغلاف (Cover)
اسم الشركة
الشعار
عبارة تعريفية مختصرة (Tagline)

2. من نحن (About Us)
تعريف مختصر بالشركة
ماذا نقدم
لمن نقدم خدماتنا

3. رؤيتنا ورسالتنا (Vision & Mission)
الرؤية
الرسالة
القيم الأساسية

4. المشكلة في السوق (Market Problem)
تحديات التسويق العقاري
لماذا يفشل البيع التقليدي

5. الحل الذي نقدمه (Our Solution)
كيف نحل المشكلة
منهجية العمل
الفرق بيننا وبين السوق

6. خدماتنا (Services)
إدارة الحملات الإعلانية
إدارة السوشيال ميديا
إنتاج المحتوى (فيديو / صور)
إدارة العملاء (CRM / Leads)
تطوير المواقع العقارية
الأتمتة والذكاء الاصطناعي

7. منهجية العمل (Our Process)
من أول إعلان إلى إغلاق الصفقة
خطوات العمل بشكل واضح (Lead → تواصل → زيارة → بيع)


9. نتائجنا (Results & Achievements)
أرقام

10. لماذا نحن؟ (Why Choose Us)
نقاط القوة
ما يميزنا عن المنافسين
القيمة الفعلية للعميل

13. التقنيات التي نستخدمها (Technology)

14. تواصل معنا (Contact Us)
رقم الهاتف
البريد الإلكتروني
الموقع
حسابات التواصل`;

async function main() {
  const client = new Anthropic();

  const t0 = Date.now();
  const turn = client.beta.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 8192,
    betas: BETAS,
    container: { skills: [{ type: "custom", skill_id: SKILL_ID, version: "latest" }] },
    system: SYSTEM,
    messages: [{ role: "user", content: `Brief:\n${BRIEF}\n\nLanguage hint: Arabic preferred — default the deck to Arabic RTL with Amiri.` }],
    tools: [{ type: "code_execution_20250825", name: "code_execution" }],
  });

  // Capture file_id from EVERY event as it streams.
  let liveFileId = null;
  let eventCount = 0;
  for await (const event of turn) {
    eventCount++;
    const json = JSON.stringify(event);
    if (json.includes("file_id")) {
      const m = json.match(/"file_id"\s*:\s*"([^"]+)"/);
      if (m) {
        liveFileId = m[1];
        console.log(`  [event ${eventCount}] type=${event.type} → file_id=${liveFileId}`);
      }
    }
    if (event.type === "content_block_start" || event.type === "content_block_stop") {
      console.log(`  [event ${eventCount}] ${event.type} index=${event.index} block_type=${event.content_block?.type ?? '?'}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nelapsed: ${elapsed}s, ${eventCount} events`);
  console.log(`live file_id (captured during stream): ${liveFileId}`);

  const response = await turn.finalMessage();
  console.log(`\nfinalMessage stop_reason: ${response.stop_reason}`);
  console.log(`content blocks: ${response.content.length}`);
  for (let i = 0; i < response.content.length; i++) {
    console.log(`  [${i}] type=${response.content[i].type}`);
  }

  // Recursive walk
  let walkFileId = null;
  const seen = new Set();
  const stack = [...response.content];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (k === "file_id" && typeof v === "string") {
        walkFileId = v;
        console.log(`  walk found file_id=${v}`);
      } else if (v && typeof v === "object") stack.push(v);
    }
  }
  console.log(`\nwalk file_id (from finalMessage): ${walkFileId}`);

  // Show last text block content
  const textBlocks = response.content.filter(b => b.type === "text");
  if (textBlocks.length) {
    console.log(`\nfinal text: "${textBlocks[textBlocks.length - 1].text?.slice(0, 300)}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
