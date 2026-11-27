import { useEffect, useState } from 'react';
import { PlugZap, WandSparkles } from 'lucide-react';
import { SettingsActions, type SettingsActionPlacement } from './settings-actions';
import { ApiKeyField, numberIssue, SettingsField, SettingsGroup, type SettingsStatus, type SettingsStatusReporter } from './settings-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/select-field';
import { SuggestInput } from '@/components/suggest-input';
import { ErrorNotice, Loading } from '@/components/common';
import { api, errorMessage } from '@/lib/api';
import { useDraft } from '@/lib/drafts';
import { SPEECH_INSTRUCTION_PRESETS } from '@/lib/voice-api';
import { toast } from '@/components/ui/toast';

type SpeechCatalog = {
  models: { id: string; name: string }[];
  voices: { id: string; name: string }[];
  model_source: string;
  voice_source: string;
};

type Service = 'authoring' | 'speech';
type Settings = Record<string, string | number | boolean> & { revision: number; key_configured: boolean };
type Group = 'primary' | 'advanced';
type Field = { key: string; label: string; group: Group; hint?: string; min?: number; max?: number; step?: number; options?: string[]; placeholder?: string };
const fields: Record<Service, Field[]> = {
  authoring: [
    { key: 'base_url', label: 'API 地址', group: 'primary', placeholder: 'https://api.deepseek.com' },
    { key: 'model', label: '模型名称', group: 'primary', placeholder: 'deepseek-flash' },
    { key: 'vision_model', label: '页面图像模型', group: 'primary', placeholder: '可选，用于识别课件页图' },
    { key: 'daily_pages', label: '每门课程每日生成页数', group: 'primary', min: 1, max: 10000 },
    { key: 'effort', label: '思考模式', group: 'advanced', options: ['none', 'minimal', 'low', 'medium', 'high'] },
    { key: 'max_tokens', label: '每次回复上限（tokens）', group: 'advanced', min: 128, max: 65536, hint: '推荐 ≥ 8000' },
    { key: 'timeout', label: '请求超时（秒）', group: 'advanced', min: 10, max: 600 },
  ],
  speech: [
    { key: 'protocol', label: '语音接口协议', group: 'primary', options: ['openai', 'deepseek', 'dashscope'] },
    { key: 'base_url', label: 'API 地址', group: 'primary', placeholder: 'https://api.example.com', hint: '留空停用语音合成' },
    { key: 'model', label: '模型名称', group: 'primary' },
    { key: 'voice', label: '音色名称 / ID', group: 'primary' },
    { key: 'format', label: '返回音频格式', group: 'advanced', options: ['mp3', 'wav', 'pcm', 'opus', 'flac', 'aac'] },
    { key: 'speed', label: '合成语速', group: 'advanced', min: 0.25, max: 4, step: 0.05 },
    { key: 'timeout', label: '请求超时（秒）', group: 'advanced', min: 10, max: 600 },
  ],
};
const labels: Record<string, string> = { none: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', stella: 'Stella（女声）', tide: 'Tide（男声）', openai: 'OpenAI 兼容语音接口', deepseek: 'DeepSeek 工具语音接口', dashscope: '阿里百炼原生语音接口' };
const text = (value: unknown) => String(value ?? '').trim();

function serviceStatus(service: Service, value: Settings): SettingsStatus {
  const url = text(value.base_url), model = text(value.model);
  if (service === 'speech') {
    if (!url) return { tone: 'off', text: '未启用' };
    const ready = value.key_configured && text(value.voice) && (value.protocol === 'deepseek' || model);
    return ready ? { tone: 'ok', text: '已配置' } : { tone: 'warn', text: '待完善' };
  }
  if (!url && !model && !value.key_configured) return { tone: 'off', text: '未配置' };
  return url && model && value.key_configured ? { tone: 'ok', text: '已配置' } : { tone: 'warn', text: '待完善' };
}

export function ServiceSettings({ service, active, onStatus }: SettingsActionPlacement & { service: Service; onStatus?: SettingsStatusReporter }) {
  const [saved, setSaved] = useState<Settings>(), [draft, setDraft] = useState<Settings>();
  const [catalog, setCatalog] = useState<SpeechCatalog>();
  const [key, setKey] = useState(''), [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const dirty = !!saved && (JSON.stringify(saved) !== JSON.stringify(draft) || !!key || clearKey);
  useDraft(dirty);
  const path = `/teacher/services/${service}`;
  useEffect(() => {
    const controller = new AbortController();
    void api.get<Settings>(path, controller.signal).then(value => {
      if (!controller.signal.aborted) { setSaved(value); setDraft(value); }
    }).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [path]);
  useEffect(() => {
    if (service !== 'speech' || !saved) return;
    const controller = new AbortController();
    void api.get<SpeechCatalog>('/teacher/services/speech/catalog', controller.signal)
      .then(value => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [service, saved?.key_configured, saved?.revision]);
  useEffect(() => { if (saved) onStatus?.({ ...serviceStatus(service, saved), dirty }); }, [service, saved, dirty, onStatus]);
  const speech = service === 'speech';
  const deepseek = speech && draft?.protocol === 'deepseek';
  const dashscope = speech && draft?.protocol === 'dashscope';
  const visibleFields = fields[service].filter(field => !(deepseek && ['model', 'speed'].includes(field.key))).map(field => {
    if (deepseek && field.key === 'voice') return { ...field, options: ['stella', 'tide'] };
    if (deepseek && field.key === 'format') return { ...field, options: ['wav', 'pcm'] };
    if (dashscope && field.key === 'format') return { ...field, options: ['mp3', 'wav', 'pcm', 'opus'] };
    return field;
  });
  const issues = Object.fromEntries(visibleFields.filter(field => field.min !== undefined && field.max !== undefined)
    .map(field => [field.key, draft ? numberIssue(draft[field.key], field.min!, field.max!, field.step === undefined) : ''])) as Record<string, string>;
  const invalid = Object.values(issues).some(Boolean);
  const advancedInvalid = visibleFields.some(field => field.group === 'advanced' && issues[field.key]);
  async function testSpeech() {
    setBusy(true); setError('');
    try {
      const result = await api.post<{ elapsed_ms: number; bytes: number; format: string }>('/teacher/services/speech/test', {});
      toast.add({ title: '连接正常', description: `${result.elapsed_ms} ms · ${result.format} · ${(result.bytes / 1024).toFixed(1)} KB`, type: 'success' });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function save() {
    if (!draft || !saved || busy || invalid) return;
    setBusy(true); setError('');
    try {
      const cleaned = Object.fromEntries(
        fields[service].map(({ key: name, min }) => {
          const raw = draft[name];
          return [name, min === undefined && typeof raw === 'string' ? raw.trim() : raw];
        }),
      );
      if (speech && draft.instruction !== undefined) {
        cleaned.instruction = String(draft.instruction).trim();
      }
      const trimmedKey = key.trim();
      const value = await api.put<Settings>(path, {
        ...cleaned,
        expected_revision: saved.revision, api_key: trimmedKey || null, clear_key: clearKey,
      });
      setSaved(value); setDraft(value); setKey(''); setClearKey(false);
      toast.add({ title: '设置已保存', type: 'success' });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  function applyProtocol(protocol: string, replace = false) {
    if (!draft) return;
    const example = protocol === 'deepseek'
      ? { base_url: 'https://api.deepseek.com', model: '', voice: 'stella', format: 'wav', speed: 1 }
      : protocol === 'dashscope'
        ? { base_url: 'https://workspace-id.cn-beijing.maas.aliyuncs.com', model: 'qwen-audio-3.1-tts-flash', voice: 'longanhuan_v3.1', format: 'mp3', speed: 1 }
        : { base_url: 'https://api.openai.com', model: 'tts-1', voice: 'alloy', format: 'mp3', speed: 1 };
    // Custom endpoints remain intact unless the explicit example action is used.
    const known = ['', 'https://api.deepseek.com', 'https://api.openai.com'];
    const root = String(draft.base_url).replace(/\/+$/, '').replace(/\/v1(?:\/(?:tools\/tts|audio\/speech))?$/, '');
    setDraft({ ...draft, ...example, base_url: replace || known.includes(root) ? example.base_url : draft.base_url, protocol });
    toast.add({ title: '示例已填入，请核对后保存。', type: 'info' });
  }
  function renderField(field: Field) {
    if (!draft) return null;
    const id = `${service}-${field.key}`;
    const numeric = field.min !== undefined;
    const placeholder = field.key === 'base_url' && deepseek ? 'https://api.deepseek.com'
      : field.key === 'base_url' && dashscope ? 'https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com' : field.placeholder;
    const hintParts = [field.hint, numeric ? `范围 ${field.min}–${field.max}` : ''].filter(Boolean);
    return <SettingsField key={field.key} id={id} label={field.label}
      hint={hintParts.join(' · ')} error={issues[field.key]}>
      {field.options ? <SelectField id={id} value={String(draft[field.key])} onValueChange={value => {
        if (field.key === 'protocol') applyProtocol(value); else setDraft({ ...draft, [field.key]: value });
      }}>
        {field.options.map(value => <option key={value} value={value}>{labels[value] ?? value}</option>)}
      </SelectField> : speech && (field.key === 'model' || field.key === 'voice') ? (
        <SuggestInput
          id={id}
          value={String(draft[field.key])}
          onChange={value => setDraft({ ...draft, [field.key]: value })}
          options={(field.key === 'model' ? catalog?.models : catalog?.voices) ?? []}
          placeholder={field.placeholder}
          label={field.label}
        />
      ) : <Input id={id} type={numeric ? 'number' : 'text'} min={field.min} max={field.max} step={field.step}
        aria-invalid={!!issues[field.key]} aria-describedby={hintParts.length || issues[field.key] ? `${id}-hint` : undefined}
        placeholder={placeholder}
        value={String(draft[field.key] ?? '')}
        onChange={e => setDraft({ ...draft, [field.key]: numeric ? (e.target.value === '' ? '' : e.target.valueAsNumber) : e.target.value })} />}
    </SettingsField>;
  }
  const group = (name: Group) => visibleFields.filter(field => field.group === name).map(renderField);
  return <section className="settings-panel">
    <ErrorNotice message={error} />
    {!draft ? (!error && <Loading />) : <fieldset disabled={busy} className="settings-stack">
      <SettingsGroup title="基础配置" headerAction={speech && <>
        <Button type="button" variant="outline" size="sm" onClick={() => {
          if (window.confirm('将地址、音色和格式等替换为接口示例？API Key 保持不变，保存后生效。')) applyProtocol(String(draft.protocol), true);
        }}><WandSparkles />填入示例</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || dirty || !saved?.key_configured} onClick={() => void testSpeech()}>
          <PlugZap />测试已保存连接
        </Button>
      </>}>
        <div className="settings-grid">
          {group('primary')}
          <ApiKeyField id={`${service}-key`} configured={!!saved?.key_configured}
            value={key} clear={clearKey} onValueChange={setKey} onClearChange={value => { setClearKey(value); setKey(''); }} />
          {dashscope && <SettingsField id="speech-instruction" label="默认朗读风格指令" wide
            extra={<span className="settings-field-actions">
              {SPEECH_INSTRUCTION_PRESETS.map(preset => <Button key={preset.id} type="button" size="xs"
                variant={String(draft.instruction ?? '') === preset.text ? 'secondary' : 'outline'}
                onClick={() => setDraft({ ...draft, instruction: preset.text })}>{preset.label}</Button>)}
              {Boolean(draft.instruction) && <Button type="button" size="xs" variant="ghost" onClick={() => setDraft({ ...draft, instruction: '' })}>清空</Button>}
            </span>}>
            <Input id="speech-instruction" maxLength={200}
              placeholder="可选，留空跟随音色默认表现"
              value={String(draft.instruction ?? '')} onChange={e => setDraft({ ...draft, instruction: e.target.value })} />
          </SettingsField>}
        </div>
      </SettingsGroup>
      <SettingsGroup title="高级设置" collapsible forceOpen={advancedInvalid}>
        <div className="settings-grid">{group('advanced')}</div>
        {deepseek && <div className="settings-group-footer">
          <p className="hint"><a className="underline" href="https://api-docs.deepseek.com/zh-cn/guides/tts/" target="_blank" rel="noreferrer">DeepSeek 语音接口说明</a></p>
        </div>}
      </SettingsGroup>
    </fieldset>}
    <SettingsActions active={active} dirty={dirty} busy={busy} saveDisabled={invalid} onSave={() => void save()} onCancel={() => {
      if (window.confirm('放弃当前未保存的修改？')) { setDraft(saved); setKey(''); setClearKey(false); setError(''); }
    }} />
  </section>;
}
