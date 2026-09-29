import { createContext, useContext, type ReactNode } from 'react';

/**
 * True while a settings page is rendered as a TAB inside a combined page
 * (Team & Access, WhatsApp, Workflows → Webhooks). Embedded pages drop their
 * own "← Settings" link and title block — the combined page already shows both.
 */
const EmbeddedCtx = createContext(false);

export const useSettingsEmbedded = (): boolean => useContext(EmbeddedCtx);

export function SettingsEmbedded({ children }: { children: ReactNode }) {
  return <EmbeddedCtx.Provider value>{children}</EmbeddedCtx.Provider>;
}
