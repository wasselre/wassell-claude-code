// Helpers for reading project data out of the generic `records` JSONB column.
// The all_projects model stores each project's fields in records.data keyed by
// the field `name` (snake_case slug) defined in the model schema. Our edge
// functions need a flat { projectName, developer, city, … } object.

import { getServiceClient } from "./supabase.ts";

export interface ProjectPayload {
  projectName: string;
  developer: string;
  city: string;
  district: string;
  type: string;
  website: string;
  socialMedia: string;
  brochure: string;
  projectPage: string;
  locationLink: string;
  locationText: string;
  minPrice?: string;
  maxPrice?: string;
  unitType?: string;
  unitsAvailable?: string;
  status?: string;
  // Raw data blob for fields not in the curated list above — agents can scan it too.
  raw: Record<string, unknown>;
}

export async function loadProjectPayload(recordId: string): Promise<ProjectPayload | null> {
  const sb = getServiceClient();
  // unified_records — works whether the project lives in JSONB records or in
  // a frozen all_projects table.
  const { data, error } = await sb
    .from("unified_records")
    .select("id, data")
    .eq("id", recordId)
    .single();
  if (error || !data) {
    console.error("[loadProjectPayload]", error?.message ?? "not found");
    return null;
  }
  const d = (data.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

  return {
    projectName: str(d.project_name ?? d.name),
    developer: str(d.developer ?? d.developer_name),
    city: str(d.city),
    district: str(d.district),
    type: str(d.project_type ?? d.type),
    website: str(d.website ?? d.website_url),
    socialMedia: str(d.social_media),
    brochure: str(d.brochure ?? d.brochure_url),
    projectPage: str(d.project_page),
    locationLink: str(d.location_url ?? d.location_link),
    locationText: str(d.location_text ?? d.location),
    minPrice: str(d.min_price),
    maxPrice: str(d.max_price),
    unitType: str(d.unit_type ?? d.item_mo4kz61h),
    unitsAvailable: str(d.units_available),
    status: str(d.project_status ?? d.status),
    raw: d,
  };
}

/** Build the user message sent to the research agent. */
export function buildResearchMessage(p: ProjectPayload): string {
  const rows = [
    ["اسم المشروع", p.projectName],
    ["المطور", p.developer],
    ["المدينة", p.city],
    ["الحي", p.district],
    ["نوع المشروع", p.type],
    ["الموقع الإلكتروني", p.website],
    ["منصات التواصل", p.socialMedia],
    ["برشور المشروع", p.brochure],
    ["صفحة المشروع", p.projectPage],
    ["رابط الموقع", p.locationLink],
    ["الموقع كتابة", p.locationText],
  ];
  const body = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  return `ابحث عن المشروع التالي وأعطني معلومات شاملة:\n\n${body}`;
}

/** Compact markdown summary of the project fields — used when the research
 *  agent output is not available yet (e.g. research disabled or failed). */
export function formatProjectFieldsAsMarkdown(p: ProjectPayload): string {
  const lines = [
    `# ${p.projectName || "مشروع بلا اسم"}`,
    "",
    "| الحقل | القيمة |",
    "|---|---|",
    `| المطور | ${p.developer} |`,
    `| المدينة | ${p.city} |`,
    `| الحي | ${p.district} |`,
    `| نوع المشروع | ${p.type} |`,
    `| نوع الوحدة | ${p.unitType ?? ""} |`,
    `| أقل سعر | ${p.minPrice ?? ""} |`,
    `| أعلى سعر | ${p.maxPrice ?? ""} |`,
    `| حالة المشروع | ${p.status ?? ""} |`,
    `| الموقع الإلكتروني | ${p.website} |`,
  ];
  return lines.join("\n");
}

/** Convert research_output JSONB to a readable markdown the agents can consume. */
// deno-lint-ignore no-explicit-any
export function researchOutputToMarkdown(output: any): string {
  if (!output || !Array.isArray(output.facts) || output.facts.length === 0) {
    return "";
  }
  const titleFact = output.facts.find((f: { dataType: string }) => f.dataType === "اسم المشروع");
  const title = titleFact?.value ?? "معلومات المشروع";
  const lines = [`# ${title}`, "", "| نوع البيانات | القيمة | المصدر |", "|---|---|---|"];
  for (const f of output.facts) {
    lines.push(`| ${f.dataType ?? ""} | ${f.value ?? ""} | ${f.source ?? ""} |`);
  }
  return lines.join("\n");
}
