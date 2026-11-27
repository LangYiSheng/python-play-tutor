import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import './settings-layout.css';

export type SettingsStatus = { tone: 'ok' | 'warn' | 'off'; text: string; dirty?: boolean };
export type SettingsStatusReporter = (status: SettingsStatus) => void;

/** Returns a readable message when a numeric draft value is empty, out of range or not an integer. */
export function numberIssue(value: unknown, min: number, max: number, integer = true): string {
  const valid = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
  return valid ? '' : `请输入 ${min}–${max} 之间的${integer ? '整数' : '数值'}`;
}

export function SettingsGroup({ title, headerAction, collapsible = false, forceOpen = false, children }: {
  title: string; headerAction?: ReactNode; collapsible?: boolean; forceOpen?: boolean; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  if (!collapsible) {
    return <section className="settings-group" data-collapsed={false}>
      <header className="settings-group-header">
        <div className="settings-group-bar">
          <h3 className="settings-group-heading">{title}</h3>
          {headerAction && <div className="settings-group-actions">{headerAction}</div>}
        </div>
      </header>
      <div id={bodyId} className="settings-group-body">{children}</div>
    </section>;
  }
  const open = expanded || forceOpen;
  return <Collapsible render={<section className="settings-group" data-collapsible="true" data-collapsed={!open} />} open={open} onOpenChange={setExpanded}>
    <header className="settings-group-header">
      <CollapsibleTrigger type="button" className="settings-group-toggle">
        <span>{title}</span>
        <ChevronDown aria-hidden="true" />
      </CollapsibleTrigger>
    </header>
    <CollapsibleContent id={bodyId}>
      <div className="settings-group-body">{children}</div>
    </CollapsibleContent>
  </Collapsible>;
}

export function SettingsField({ id, label, hint, error, extra, wide, children }: {
  id: string; label: string; hint?: ReactNode; error?: string;
  extra?: ReactNode; wide?: boolean; children: ReactNode;
}) {
  const message = error || hint;
  return <div className={`field settings-field${wide ? ' settings-field-wide' : ''}`}>
    <div className="settings-field-label">
      <Label htmlFor={id}>{label}</Label>
      {extra}
    </div>
    {children}
    {message && <p id={`${id}-hint`} className="hint settings-hint" data-tone={error ? 'error' : 'normal'}>{message}</p>}
  </div>;
}

export function ApiKeyField({ id, configured, placeholder, value, clear, onValueChange, onClearChange }: {
  id: string; configured: boolean; placeholder?: string; value: string; clear: boolean;
  onValueChange: (value: string) => void; onClearChange: (clear: boolean) => void;
}) {
  const state = clear ? '保存后清除' : configured ? '已配置' : '未配置';
  const resolvedPlaceholder = clear ? '保存后将清除密钥' : configured ? (placeholder || '已保存，留空保持不变') : '填写 API Key';
  return <SettingsField id={id} label="API Key"
    extra={<Badge variant={clear ? 'destructive' : configured ? 'secondary' : 'outline'}>{state}</Badge>}>
    <Input id={id} type="password" autoComplete="new-password"
      value={value} placeholder={resolvedPlaceholder} disabled={clear} onChange={e => onValueChange(e.target.value)} />
    {(configured || clear) && <Label className="gap-2 font-normal text-muted-foreground">
      <Checkbox checked={clear} onCheckedChange={checked => onClearChange(Boolean(checked))} />清除已保存密钥
    </Label>}
  </SettingsField>;
}
