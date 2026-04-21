// Shapes we exchange with HaberChat and with ourselves inside the edge function.
// Kept minimal — only the fields we actually read. HaberChat's real payload has
// more fields; we just don't depend on them.

export interface HaberchatInboundMessage {
  event?: string;
  objectEvent?: string;
  flow?: "in" | "out" | string;
  kind?: "text" | "image" | "video" | "audio" | "document" | "location" | string;
  body?: string;
  from?: string;          // sender phone (sometimes E.164 w/ +, sometimes bare digits)
  chatWid?: string;       // "<phone>@c.us" for 1:1, "<id>@g.us" for groups
  chat?: { isGroup?: boolean; id?: string; wid?: string };
  fromContact?: { name?: string; phone?: string };
  date?: string;
  // HaberChat may wrap the event in { event, data: {...} } — we handle both.
  data?: HaberchatInboundMessage;
}

export interface Preferences {
  unit_type?: string;
  budget_min?: number;
  budget_max?: number;
  city?: string;
  district?: string;
  project_status?: "off_plan" | "under_construction" | "ready";
  min_size?: number;
  max_size?: number;
  text_query?: string;
  notes?: string;
}

export interface ConversationRow {
  phone: string;
  messages: AnthropicMessage[];
  lead_summary: Preferences;
  contact_name: string | null;
  language: "ar" | "en";
  last_chat_id: string | null;
  turn_count: number;
}

// Anthropic message shape — content can be a string (simple) or an array of
// content blocks (for tool_use / tool_result turns). We store whatever the SDK
// produced or consumed verbatim in JSONB.
export type AnthropicMessage =
  | { role: "user"; content: string | AnthropicContentBlock[] }
  | { role: "assistant"; content: string | AnthropicContentBlock[] };

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
    };

export interface ProjectHit {
  id: string;
  project_name: string;
  developer: string | null;
  city: string | null;
  district: string | null;
  project_status: string | null;
  min_price: number | null;
  max_price: number | null;
  project_url: string | null;
  brochure_link: string | null;
  score: number;
}
