import { create } from 'zustand';

/**
 * The number picked in the Chats switcher — `null` means "all numbers".
 *
 * Shared by the chat list (which conversations show) and the open
 * conversation (which number a reply goes out from). Lives outside the
 * components so opening a chat, which remounts the list, keeps the choice.
 */
interface ChatLineFilterState {
  line: string | null;
  setLine: (line: string | null) => void;
}

export const useChatLineFilter = create<ChatLineFilterState>((set) => ({
  line: null,
  setLine: (line) => set({ line }),
}));
