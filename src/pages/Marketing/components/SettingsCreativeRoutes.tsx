/**
 * Route wrappers for the four Creative Director settings screens. Each reads
 * the workspace's capability set and passes the gates down, so App.tsx stays a
 * route table and the screens stay prop-driven (the same shape as the other
 * Settings* components rendered by SettingsSectionPage).
 */
import { useWorkspace } from '../MarketingWorkspace';
import SettingsBrandKit from './SettingsBrandKit';
import SettingsWriterRules from './SettingsWriterRules';
import SettingsAiRoles from './SettingsAiRoles';
import SettingsCreativeFlags from './SettingsCreativeFlags';

export function BrandKitSettingsRoute() {
  const { isAr, can } = useWorkspace();
  return <SettingsBrandKit canManage={can('manage_settings')} canReview={can('approve_creative')} isAr={isAr} />;
}

export function WriterRulesSettingsRoute() {
  const { isAr, can } = useWorkspace();
  return <SettingsWriterRules canManage={can('manage_settings')} isAr={isAr} />;
}

export function AiRolesSettingsRoute() {
  const { isAr, can } = useWorkspace();
  return <SettingsAiRoles canManage={can('manage_settings')} isAr={isAr} />;
}

export function CreativeFlagsSettingsRoute() {
  const { isAr, can } = useWorkspace();
  return <SettingsCreativeFlags canManage={can('manage_settings')} isAr={isAr} />;
}
