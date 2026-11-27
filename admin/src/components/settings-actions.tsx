import type { ReactNode } from 'react';
import { LoaderCircle, Save, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type SettingsActionPlacement = { active?: boolean };

export function SettingsActions({ active = true, dirty, busy, saveDisabled, onSave, onCancel, children }: SettingsActionPlacement & {
  dirty: boolean; busy: boolean; saveDisabled?: boolean; onSave: () => void; onCancel: () => void; children?: ReactNode;
}) {
  if (!active || !dirty) return null;
  return <div className="settings-sticky-bar" role="region" aria-label="未保存修改操作">
    <span className="settings-sticky-status">有未保存的修改</span>
    <div className="settings-sticky-buttons">
      {children}
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}><Undo2 />取消编辑</Button>
      <Button type="button" disabled={busy || saveDisabled} onClick={onSave}>
        {busy ? <LoaderCircle className="animate-spin" /> : <Save />}
        {busy ? '正在保存…' : '保存设置'}
      </Button>
    </div>
  </div>;
}
