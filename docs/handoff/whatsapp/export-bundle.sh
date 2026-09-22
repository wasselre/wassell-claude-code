#!/usr/bin/env bash
# Build a self-contained bundle of this handoff folder PLUS copies of the source
# files it references, for a model or person who cannot read the repository
# (e.g. uploading to ChatGPT). Codex or Claude working inside the repo does not
# need this — they can read the paths directly.
#
# Usage (from anywhere inside the repo):
#   bash docs/handoff/whatsapp/export-bundle.sh [output-dir]
# Produces <output-dir>/whatsapp-handoff-<date>.zip (default output-dir: the
# repo's parent directory). Never includes .env files or secrets: every file
# copied is already committed to this public repository.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
OUT_DIR="${1:-$(dirname "$ROOT")}"
STAMP="$(date +%Y-%m-%d)"
NAME="whatsapp-handoff-$STAMP"
WORK="$(mktemp -d)"
DEST="$WORK/$NAME"
mkdir -p "$DEST"

# The handoff docs themselves.
mkdir -p "$DEST/docs/handoff/whatsapp"
cp "$ROOT"/docs/handoff/whatsapp/*.md "$DEST/docs/handoff/whatsapp/"

# Source files referenced by 02-file-map.md. Keep this list in step with it.
FILES=(
  api/_lib/waha.ts
  api/_lib/whatsappGateway.ts
  api/_lib/whatsappSendAuth.ts
  api/_lib/whatsappTypes.ts
  api/_lib/chatIngest.ts
  api/_lib/aiSend.ts
  api/_lib/aiSendProject.ts
  api/_lib/activityLogger.ts
  api/webhook/waha.ts
  api/haberchat/devices.ts
  api/haberchat/chats.ts
  "api/haberchat/chats/[wid].ts"
  api/haberchat/messages.ts
  api/haberchat/files.ts
  "api/haberchat/files/[id].ts"
  api/haberchat/scheduled.ts
  api/whatsapp/session.ts
  api/whatsapp/upload-url.ts
  api/whatsapp/send-media-batch.ts
  api/whatsapp/notify-officer.ts
  api/whatsapp/basic-reply.ts
  api/whatsapp/ai-send.ts
  api/whatsapp/ai-send-project.ts
  api/whatsapp/ai-handover.ts
  api/whatsapp/ai-settings.ts
  api/whatsapp/ai-notify.ts
  api/templates/project-message.ts
  api/internal/send-notification-wa.ts
  api/cron/ai-balance-probe.ts
  worker/src/index.ts
  worker/src/runScheduledWhatsappJob.ts
  worker/src/waha.ts
  worker/src/runNotificationDelivery.ts
  worker/src/runPushJob.ts
  worker/src/runUnitPdfJob.ts
  worker/src/unitPdf.ts
  worker/fly.toml
  wa-agent/runner.mjs
  wa-agent/Dockerfile
  wa-agent/entrypoint.sh
  wa-agent/fly.toml
  wa-agent/tools/send.mjs
  wa-agent/tools/project-flow.mjs
  wa-agent/tools/project.mjs
  wa-agent/tools/notify.mjs
  wa-agent/tools/db.mjs
  wa-agent/tools/save.mjs
  wa-agent/skill-basic/SKILL.md
  .claude/skills/whatsapp-basic-reply/SKILL.md
  .claude/skills/wassel-whatsapp-voice/SKILL.md
  src/lib/haberchat/client.ts
  src/lib/haberchat/normalize.ts
  src/lib/haberchat/clientHistory.ts
  src/lib/realtime/RealtimeOrchestrator.ts
  src/lib/realtime/dedup.ts
  src/pages/Chats/ChatsSplitPage.tsx
  src/pages/Chats/components/Composer.tsx
  src/pages/Chats/components/MessageThread.tsx
  src/pages/Chats/components/MessageBubble.tsx
  src/pages/Chats/components/NotifyOfficerModal.tsx
  src/pages/Chats/components/SchedulePopover.tsx
  src/pages/Settings/WhatsAppNumbersPage.tsx
  src/pages/Settings/WhatsAppAiPage.tsx
  src/pages/Settings/WhatsAppPermissionsPage.tsx
  src/components/WhatsAppOwnerAlerts.tsx
  src/components/WhatsAppOwnerBell.tsx
  src/components/whatsappOwner.ts
  supabase/schema.sql
  supabase/migrations/2026-07-18_whatsapp_provider.sql
  supabase/migrations/2026-07-18_scheduled_whatsapp_jobs_queue.sql
  supabase/migrations/2026-07-23_scheduled_whatsapp_requeue.sql
  supabase/migrations/2026-07-22_claude_jobs_queue.sql
  supabase/migrations/2026-07-26_whatsapp_ai_replies.sql
  supabase/migrations/2026-08-24_ai_schedule_mode.sql
  supabase/migrations/2026-08-24_ai_permanent_human_stop.sql
  supabase/migrations/2026-07-27_whatsapp_lid_dupes_and_bridge_number.sql
  supabase/migrations/2026-07-28_chat_messages_hash_uniqueness.sql
  supabase/migrations/2026-07-28_whatsapp_per_number_send_budget.sql
  supabase/migrations/2026-07-28_whatsapp_remediation_lock_and_unknown_sends.sql
  supabase/migrations/2026-07-28_whatsapp_scope_message_visibility.sql
  supabase/migrations/2026-07-28_whatsapp_send_source_scoped_supersede.sql
  supabase/migrations/2026-07-28_whatsapp_takeover_scoped_override.sql
  supabase/migrations/2026-07-28_whatsapp_retire_haberchat_scaffolding.sql
  supabase/migrations/2026-07-29_claude_runner_singleton_lease.sql
  supabase/migrations/2026-07-29_waha_remediation_backoff.sql
  supabase/migrations/2026-07-29_web_push.sql
  supabase/migrations/2026-08-01_04_notifications_platform.sql
  supabase/migrations/2026-08-05_mos_step_notify_channels.sql
  supabase/migrations/2026-08-14_chat_client_owner_mirror.sql
  supabase/migrations/2026-08-18_09_whatsapp_inbound_push.sql
  supabase/migrations/2026-08-18_11_whatsapp_inbound_inbox_fallback.sql
  supabase/migrations/2026-08-31_ops_number_designation.sql
  supabase/migrations/2026-09-03_chat_status_log.sql
  supabase/migrations/2026-09-13_unit_pdf_jobs_queue.sql
  supabase/migrations/2026-09-21_ai_vendor_truth_and_alerts.sql
  supabase/migrations/2026-07-21_whatsapp_activity_bridge.sql
  supabase/migrations/2026-07-04_whatsapp_reply_reconcile.sql
  docs/runbooks/whatsapp.md
  docs/waha-doha-gateway.md
  docs/ops-whatsapp-personal-style.md
  docs/evaluations/2026-07-18-waha-vs-haberchat.md
  docs/prd/chats.md
)

missing=0
for f in "${FILES[@]}"; do
  if [ -f "$ROOT/$f" ]; then
    mkdir -p "$DEST/$(dirname "$f")"
    cp "$ROOT/$f" "$DEST/$f"
  else
    echo "WARN: missing $f (file map may be stale)" >&2
    missing=$((missing + 1))
  fi
done

# Refuse to bundle anything that looks like a secret value.
if grep -rIl -E "sk-ant-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}|sb_secret_[A-Za-z0-9_-]{10,}" "$DEST" >/dev/null 2>&1; then
  echo "ABORT: a file in the bundle contains what looks like a secret value" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/$NAME.zip"
rm -f "$ZIP"
if command -v zip >/dev/null 2>&1; then
  (cd "$WORK" && zip -qr "$ZIP" "$NAME")
elif command -v powershell.exe >/dev/null 2>&1; then
  WIN_SRC="$(cd "$WORK" && pwd -W 2>/dev/null || pwd)/$NAME"
  WIN_ZIP="$(cd "$OUT_DIR" && pwd -W 2>/dev/null || pwd)/$NAME.zip"
  powershell.exe -NoProfile -Command "Compress-Archive -Path '$WIN_SRC' -DestinationPath '$WIN_ZIP' -Force"
else
  ZIP="$OUT_DIR/$NAME.tar.gz"
  tar -czf "$ZIP" -C "$WORK" "$NAME"
fi

count=$(find "$DEST" -type f | wc -l | tr -d ' ')
echo "bundle: $ZIP ($count files, $missing missing)"
rm -rf "$WORK"
