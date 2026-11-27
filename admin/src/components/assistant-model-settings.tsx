import { useEffect, useState } from 'react';
import { PlugZap, RotateCcw } from 'lucide-react';
import { SettingsActions, type SettingsActionPlacement } from './settings-actions';
import { ApiKeyField, numberIssue, SettingsField, SettingsGroup, type SettingsStatus, type SettingsStatusReporter } from './settings-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { SelectField } from '@/components/select-field';
import { ErrorNotice } from '@/components/common';
import { SettingsSkeleton } from '@/components/skeletons';
import { api, errorMessage } from '@/lib/api';
import { useDraft } from '@/lib/drafts';
import { toast } from '@/components/ui/toast';

type NumberKey = 'context_window' | 'compression_threshold' | 'output_tokens' | 'model_calls' | 'tool_calls' | 'timeout_seconds' | 'request_tokens';
type ModelSettings = Record<NumberKey, number> & {
  enabled: boolean; revision: number; base_url: string; model: string; reasoning_effort: string;
  user_daily_requests: number;
  key_configured: boolean; key_mask: string; source: string; token_counting: string;
};
type ModelSettingsDraft = Omit<ModelSettings, NumberKey | 'user_daily_requests'> & Record<NumberKey | 'user_daily_requests', number | ''>;
const numbers: { key: NumberKey; label: string; min: number; max: number; recommended: number }[] = [
  { key: 'context_window', label: '上下文上限（tokens）', min: 8192, max: 2000000, recommended: 32768 },
  { key: 'compression_threshold', label: '压缩阈值（tokens）', min: 4096, max: 1900000, recommended: 24576 },
  { key: 'output_tokens', label: '每次回复上限（tokens）', min: 128, max: 8192, recommended: 2048 },
  { key: 'model_calls', label: '每次请求最多模型调用', min: 1, max: 20, recommended: 6 },
  { key: 'tool_calls', label: '每次请求最多工具调用', min: 0, max: 40, recommended: 12 },
  { key: 'timeout_seconds', label: '请求超时（秒）', min: 10, max: 300, recommended: 120 },
  { key: 'request_tokens', label: '每次请求总预算（tokens）', min: 8192, max: 2000000, recommended: 262144 },
];

function assistantStatus(value: ModelSettings): SettingsStatus {
  if (!value.enabled) return { tone: 'off', text: '已关闭' };
  return value.key_configured && value.base_url.trim() && value.model.trim() ? { tone: 'ok', text: '已就绪' } : { tone: 'warn', text: '待完善' };
}

export function AssistantModelSettings({ onSaved, onStatus, active }: SettingsActionPlacement & {
  onSaved?: (limits: Record<string, number>) => void; onStatus?: SettingsStatusReporter;
}) {
  const [saved, setSaved] = useState<ModelSettings>(), [draft, setDraft] = useState<ModelSettingsDraft>();
  const [key, setKey] = useState(''), [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const dirty = !!saved && (JSON.stringify(saved) !== JSON.stringify(draft) || !!key || clearKey);
  const dailyInvalid = !!draft && !!numberIssue(draft.user_daily_requests, 0, Number.MAX_SAFE_INTEGER);
  const issues = Object.fromEntries(numbers.map(({ key: name, min, max }) => [name, draft ? numberIssue(draft[name], min, max) : ''])) as Record<NumberKey, string>;
  const advancedInvalid = Object.values(issues).some(Boolean);
  useDraft(dirty);
  useEffect(() => {
    const controller = new AbortController();
    void api.get<ModelSettings>('/teacher/assistant/model', controller.signal).then(value => {
      if (!controller.signal.aborted) { setSaved(value); setDraft(value); }
    }).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, []);
  useEffect(() => { if (saved) onStatus?.({ ...assistantStatus(saved), dirty }); }, [saved, dirty, onStatus]);
  async function save() {
    if (!draft || !saved || busy || dailyInvalid || advancedInvalid) return;
    setBusy(true); setError('');
    try {
      const value = await api.put<ModelSettings>('/teacher/assistant/model', {
        enabled: draft.enabled, expected_revision: saved.revision, base_url: draft.base_url.trim(), model: draft.model.trim(), reasoning_effort: draft.reasoning_effort,
        user_daily_requests: draft.user_daily_requests,
        ...Object.fromEntries(numbers.map(({ key: name }) => [name, draft[name]])), api_key: key.trim() || null, clear_key: clearKey,
      });
      setSaved(value); setDraft(value); setKey(''); setClearKey(false);
      toast.add({ title: '设置已保存', type: 'success' });
      onSaved?.(Object.fromEntries(numbers.map(({ key: name }) => [name, value[name]])));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError('');
    try {
      const result = await api.post<{ elapsed_ms: number; tokens: number }>('/teacher/assistant/model/test', {});
      toast.add({ title: '连接正常', description: `${result.elapsed_ms} ms · ${result.tokens} tokens`, type: 'success' });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <section className="settings-panel">
    <ErrorNotice message={error} />
    {!draft ? (!error && <SettingsSkeleton />) : <fieldset disabled={busy} className="settings-stack">
      <SettingsGroup title="基础配置" headerAction={
        <Button type="button" variant="outline" size="sm" disabled={busy || dirty || !saved?.key_configured} onClick={() => void test()}>
          <PlugZap />测试已保存连接
        </Button>
      }>
        <Label className="settings-switch gap-2"><Checkbox checked={draft.enabled} onCheckedChange={v => setDraft({ ...draft, enabled: Boolean(v) })} />开放全平台学生答疑</Label>
        <div className="settings-grid">
          <SettingsField id="model-url" label="API 地址">
            <Input id="model-url" placeholder="https://api.deepseek.com" value={draft.base_url} onChange={e => setDraft({ ...draft, base_url: e.target.value })} />
          </SettingsField>
          <SettingsField id="model-name" label="模型名称">
            <Input id="model-name" placeholder="deepseek-flash" value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} />
          </SettingsField>
          <ApiKeyField id="model-key" configured={!!saved?.key_configured} placeholder={saved?.key_mask} value={key} clear={clearKey}
            onValueChange={setKey} onClearChange={value => { setClearKey(value); setKey(''); }} />
          <SettingsField id="model-user-daily-requests" label="每名学生每日提问上限"
            hint="跨班共用，每天 08:00 重置，0 为禁止提问" error={dailyInvalid ? '请输入大于或等于 0 的整数' : ''}>
            <Input id="model-user-daily-requests" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1}
              aria-invalid={dailyInvalid} aria-describedby="model-user-daily-requests-hint" value={draft.user_daily_requests}
              onChange={e => setDraft({ ...draft, user_daily_requests: e.target.value === '' ? '' : e.target.valueAsNumber })} />
          </SettingsField>
        </div>
      </SettingsGroup>
      <SettingsGroup title="高级设置" collapsible forceOpen={advancedInvalid}>
        <div className="settings-grid">
          <SettingsField id="model-reasoning" label="思考模式">
            <SelectField id="model-reasoning" value={draft.reasoning_effort || 'default'} onValueChange={value => setDraft({ ...draft, reasoning_effort: value === 'default' ? '' : value })}>
              <option value="default">供应商默认</option><option value="none">关闭</option><option value="minimal">最少</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option>
            </SelectField>
          </SettingsField>
          {numbers.map(({ key: name, label, min, max, recommended }) => <SettingsField key={name} id={`model-${name}`} label={label}
            hint={`推荐 ${recommended} · 范围 ${min}–${max}`} error={issues[name]}>
            <Input id={`model-${name}`} type="number" min={min} max={max} step={1} aria-invalid={!!issues[name]} aria-describedby={`model-${name}-hint`}
              value={draft[name]} onChange={e => setDraft({ ...draft, [name]: e.target.value === '' ? '' : e.target.valueAsNumber })} />
          </SettingsField>)}
        </div>
        <div className="settings-group-footer">
          <p className="hint">{draft.token_counting}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setDraft({ ...draft, ...Object.fromEntries(numbers.map(item => [item.key, item.recommended])) })}>
            <RotateCcw />恢复推荐值
          </Button>
        </div>
      </SettingsGroup>
    </fieldset>}
    <SettingsActions active={active} dirty={dirty} busy={busy} saveDisabled={dailyInvalid || advancedInvalid} onSave={() => void save()} onCancel={() => {
      if (window.confirm('放弃当前未保存的修改？')) { setDraft(saved); setKey(''); setClearKey(false); setError(''); }
    }} />
  </section>;
}
