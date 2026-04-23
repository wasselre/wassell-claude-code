import { Check, CheckCheck, Clock, AlertCircle } from 'lucide-react';
import type { ChatMessage } from '@/types';

/**
 * Outbound-only delivery tick icons. Mirrors WhatsApp's native conventions:
 *   pending   → clock
 *   sent      → one tick (gray)
 *   delivered → two ticks (gray)
 *   read      → two ticks (copper, our "blue-tick" equivalent)
 *   played    → same as read; treat voice-played as read for now
 *   failed    → red warning
 *
 * Inbound messages have no ack indicator — return null.
 */
export default function AckIndicator({ message }: { message: ChatMessage }) {
  if (message.flow !== 'out') return null;
  const ack = message.ack;

  if (ack === 'failed') {
    return <AlertCircle size={13} className="text-red-500" aria-label="failed" />;
  }
  if (ack === 'pending' || message.pending) {
    return <Clock size={13} className="text-charcoal/40" aria-label="pending" />;
  }
  if (ack === 'sent') {
    return <Check size={13} className="text-charcoal/40" aria-label="sent" />;
  }
  if (ack === 'delivered') {
    return <CheckCheck size={13} className="text-charcoal/40" aria-label="delivered" />;
  }
  if (ack === 'read' || ack === 'played') {
    return <CheckCheck size={13} className="text-copper" aria-label="read" />;
  }
  return null;
}
