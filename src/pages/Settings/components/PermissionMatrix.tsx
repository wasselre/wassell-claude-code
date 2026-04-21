import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import type { ProfileModelPermissions, ModelPermission } from '@/types';

const ALL_PERMISSIONS: ModelPermission[] = ['view', 'create', 'edit', 'delete', 'import', 'export'];
const PERM_LABELS_AR: Record<ModelPermission, string> = { view: 'عرض', create: 'إنشاء', edit: 'تعديل', delete: 'حذف', import: 'استيراد', export: 'تصدير' };
const PERM_LABELS_EN: Record<ModelPermission, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', import: 'Import', export: 'Export' };

interface PermissionMatrixProps {
  modelPermissions: ProfileModelPermissions[];
  onChange: (permissions: ProfileModelPermissions[]) => void;
}

export default function PermissionMatrix({ modelPermissions, onChange }: PermissionMatrixProps) {
  const { models, language } = useAppStore();
  const isAr = language === 'ar';
  const labels = isAr ? PERM_LABELS_AR : PERM_LABELS_EN;

  const getPerms = (modelId: string): ModelPermission[] => {
    return modelPermissions.find((mp) => mp.model_id === modelId)?.permissions ?? [];
  };

  const togglePerm = (modelId: string, perm: ModelPermission) => {
    const current = getPerms(modelId);
    const has = current.includes(perm);
    const next = has ? current.filter((p) => p !== perm) : [...current, perm];
    const existing = modelPermissions.find((mp) => mp.model_id === modelId);
    if (existing) {
      onChange(modelPermissions.map((mp) => mp.model_id === modelId ? { ...mp, permissions: next } : mp));
    } else {
      onChange([...modelPermissions, { model_id: modelId, permissions: next }]);
    }
  };

  const toggleAll = (modelId: string) => {
    const current = getPerms(modelId);
    const allSet = ALL_PERMISSIONS.every((p) => current.includes(p));
    const next = allSet ? [] : [...ALL_PERMISSIONS];
    const existing = modelPermissions.find((mp) => mp.model_id === modelId);
    if (existing) {
      onChange(modelPermissions.map((mp) => mp.model_id === modelId ? { ...mp, permissions: next } : mp));
    } else {
      onChange([...modelPermissions, { model_id: modelId, permissions: next }]);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-start py-2 px-3 font-bold text-charcoal/40 text-xs">{isAr ? 'النموذج' : 'Model'}</th>
            {ALL_PERMISSIONS.map((p) => (
              <th key={p} className="text-center py-2 px-2 font-bold text-charcoal/40 text-xs w-16">{labels[p]}</th>
            ))}
            <th className="text-center py-2 px-2 font-bold text-charcoal/40 text-xs w-16">{isAr ? 'الكل' : 'All'}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            const Icon = getIconComponent(model.icon);
            const perms = getPerms(model.id);
            const allSet = ALL_PERMISSIONS.every((p) => perms.includes(p));
            return (
              <tr key={model.id} className="border-t border-sand/10">
                <td className="py-2.5 px-3">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${model.color}12` }}>
                      <Icon size={14} style={{ color: model.color }} />
                    </div>
                    <span className="font-bold text-charcoal text-xs">{isAr ? model.label_ar : model.label_en}</span>
                  </div>
                </td>
                {ALL_PERMISSIONS.map((p) => (
                  <td key={p} className="text-center py-2.5 px-2">
                    <input
                      type="checkbox"
                      checked={perms.includes(p)}
                      onChange={() => togglePerm(model.id, p)}
                      className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
                    />
                  </td>
                ))}
                <td className="text-center py-2.5 px-2">
                  <input
                    type="checkbox"
                    checked={allSet}
                    onChange={() => toggleAll(model.id)}
                    className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
