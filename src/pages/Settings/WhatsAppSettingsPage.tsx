/**
 * «واتساب» — the WhatsApp admin hub (architecture cleanup D30, 2026-09-29):
 * the connected numbers and the AI agent's reply policy, as two tabs of one
 * page. Who can SEE which chats is an access question, so it lives in
 * Team & Access → Access levels.
 */
import { MessageCircle, Phone, Bot } from 'lucide-react';
import SettingsTabsShell from './components/SettingsTabsShell';
import WhatsAppNumbersPage from './WhatsAppNumbersPage';
import WhatsAppAiPage from './WhatsAppAiPage';

export default function WhatsAppSettingsPage() {
  return (
    <SettingsTabsShell
      titleAr="واتساب"
      titleEn="WhatsApp"
      descAr="الأرقام المتصلة بالنظام، وإعدادات المساعد الذكي. من يرى أي محادثات يُضبط في «الفريق والصلاحيات»."
      descEn="The connected numbers and the AI agent. Who sees which chats is set in Team & Access."
      icon={MessageCircle}
      color="#25D366"
      tabs={[
        { id: 'numbers', ar: 'الأرقام', en: 'Numbers', icon: Phone, render: () => <WhatsAppNumbersPage /> },
        { id: 'ai', ar: 'المساعد الذكي', en: 'AI agent', icon: Bot, render: () => <WhatsAppAiPage /> },
      ]}
    />
  );
}
