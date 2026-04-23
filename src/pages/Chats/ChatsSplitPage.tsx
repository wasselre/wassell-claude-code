import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import ChatList from './components/ChatList';
import ChatDetail, { ChatDetailEmptyPane } from './components/ChatDetail';

/**
 * Two-pane chats layout. Replaces both the standalone ChatListPage and
 * ChatDetailPage — routes `/model/chats` and `/model/chats/:recordId`
 * both land here. The left pane is always visible on desktop; on mobile
 * it collapses to show whichever pane the URL indicates (list when no
 * recordId, detail otherwise).
 *
 * Mount lifecycle: subscribes to Supabase Realtime on the whole
 * `chat_messages` table (no filter) for as long as the user is on this
 * route. That's what makes the left-pane list update live when a
 * message arrives for a conversation the user isn't currently viewing
 * — no refresh required.
 */
export default function ChatsSplitPage() {
  const { recordId } = useParams();
  const isAr = useAppStore((s) => s.language === 'ar');
  const subscribeToAllChats = useAppStore((s) => s.subscribeToAllChats);
  const unsubscribeFromAllChats = useAppStore((s) => s.unsubscribeFromAllChats);

  useEffect(() => {
    subscribeToAllChats();
    return () => unsubscribeFromAllChats();
  }, [subscribeToAllChats, unsubscribeFromAllChats]);

  return (
    <div className="chats-split h-[calc(100vh-8rem)] flex overflow-hidden rounded-2xl border border-sand/20 bg-white">
      {/* Left: list. Hidden on mobile when a chat is selected. */}
      <div
        className={`w-full md:w-[360px] shrink-0 border-e border-sand/20 flex-col ${
          recordId ? 'hidden md:flex' : 'flex'
        }`}
      >
        <ChatList selectedRecordId={recordId ?? null} />
      </div>

      {/* Right: detail or placeholder. Hidden on mobile when no chat selected. */}
      <div className={`flex-1 min-w-0 flex-col ${!recordId ? 'hidden md:flex' : 'flex'}`}>
        {recordId ? (
          <ChatDetail key={recordId} recordId={recordId} />
        ) : (
          <ChatDetailEmptyPane isAr={isAr} />
        )}
      </div>
    </div>
  );
}
