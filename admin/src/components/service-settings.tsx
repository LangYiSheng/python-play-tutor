import { useEffect, useState } from 'react';
import { PlugZap, WandSparkles } from 'lucide-react';
import { SettingsActions, type SettingsActionPlacement } from './settings-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
type Field = { key: string; label: string; min?: number; max?: number; step?: number; options?: string[]; placeholder?: string };
const shared: Field[] = [{ key: 'base_url', label: 'API 地址', placeholder: '例如：https://api.example.com' }, { key: 'model', label: '模型名称' }];
const fields: Record<Service, Field[]> = {
  authoring: [...shared, { key: 'vision_model', label: '页面图像模型' },
    { key: 'effort', label: '思考模式', options: ['none', 'minimal', 'low', 'medium', 'high'] },
    { key: 'max_tokens', label: '每次回复上限（tokens）', min: 128, max: 65536 },
    { key: 'daily_pages', label: '每门课程每日生成页数', min: 1, max: 10000 },
    { key: 'timeout', label: '请求超时（秒）', min: 10, max: 600 }],
  speech: [{ key: 'protocol', label: '语音接口协议', options: ['openai', 'deepseek', 'dashscope'] }, ...shared,
    { key: 'voice', label: '音色名称 / ID' },
    { key: 'format', label: '返回音频格式', options: ['mp3', 'wav', 'pcm', 'opus', 'flac', 'aac'] },
    { key: 'speed', label: '合成语速', min: 0.25, max: 4, step: 0.05 },
    { key: 'timeout', label: '请求超时（秒）', min: 10, max: 600 }],
};
const labels: Record<string, string> = { none: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', stella: 'Stella（女声）', tide: 'Tide（男声）', openai: 'OpenAI 兼容语音接口', deepseek: 'DeepSeek 工具语音接口', dashscope: '阿里百炼原生语音接口' };

export function ServiceSettings({ service, actionsTarget, active }: SettingsActionPlacement & { service: Service }) {
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
  async function testSpeech() {
    setBusy(true); setError('');
    try {
      const result = await api.post<{ elapsed_ms: number; bytes: number; format: string }>('/teacher/services/speech/test', {});
      toast.add({ title: '连接正常', description: `${result.elapsed_ms} ms · ${result.format} · ${(result.bytes / 1024).toFixed(1)} KB`, type: 'success' });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function save() {
    if (!draft || !saved || busy) return;
    setBusy(true); setError('');
    try {
      const cleaned = Object.fromEntries(
        fields[service].map(({ key: name, min }) => {
          const raw = draft[name];
          return [name, min === undefined && typeof raw === 'string' ? raw.trim() : raw];
        }),
      );
      if (service === 'speech' && draft.instruction !== undefined) {
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
  const deepseek = service === 'speech' && draft?.protocol === 'deepseek';
  const dashscope = service === 'speech' && draft?.protocol === 'dashscope';
  const visibleFields = fields[service].filter(field => !(deepseek && ['model', 'speed'].includes(field.key))).map(field => {
    if (deepseek && field.key === 'voice') return { ...field, options: ['stella', 'tide'] };
    if (deepseek && field.key === 'format') return { ...field, options: ['wav', 'pcm'] };
    if (dashscope && field.key === 'format') return { ...field, options: ['mp3', 'wav', 'pcm', 'opus'] };
    return field;
  });
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
  return <section className="space-y-4 py-4">
    <SettingsActions actionsTarget={actionsTarget} active={active} dirty={dirty} busy={busy} onSave={() => void save()} onCancel={() => {
      if (window.confirm('放弃当前标签的未保存修改？')) { setDraft(saved); setKey(''); setClearKey(false); setError(''); }
    }} />
    <p className="hint">适用范围：全站{service === 'authoring' ? '讲稿生成与校准' : '语音合成'}。由管理员维护，{service === 'authoring' ? '用于 PDF、演示文稿，不占用学生答疑预算。' : '仅合成教师已接受的讲稿。'}保存设置不会调用外部服务。</p>
    <ErrorNotice message={error} />
    {!draft ? (!error && <Loading />) : <fieldset disabled={busy} className="space-y-4">
      {service === 'speech' && <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 p-3">
        <p className="hint flex-1">{deepseek ? 'DeepSeek 示例：api.deepseek.com · Stella 女声 / Tide 男声 · WAV / PCM。此接口无需模型名称，合成语速固定为 1。' : dashscope ? '阿里百炼原生语音接口：地址填业务空间域名（https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com），模型如 qwen-audio-3.0-tts-flash / cosyvoice-v3-plus，音色从控制台复制；返回音频 URL 由服务端下载。' : 'OpenAI 兼容接口：填写服务基础地址、模型和音色。示例仅供配置参考，是否可用以你的供应商为准。'}</p>
        <Button type="button" variant="outline" onClick={() => {
          if (window.confirm('将地址、音色和格式等替换为接口示例？API Key 保持不变，保存后生效。')) applyProtocol(String(draft.protocol), true);
        }}><WandSparkles />填入示例</Button>
      </div>}
      {service === 'speech' && <div>
        <Button type="button" variant="outline" disabled={busy || dirty || !saved?.key_configured} onClick={() => void testSpeech()}><PlugZap />测试已保存连接</Button>
        <p className="hint mt-2">会发送一次短语音请求；有未保存修改时请先保存或取消，测试不保存音频。</p>
      </div>}
      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">{visibleFields.map(field => <div className="field" key={field.key}>
        <Label htmlFor={`${service}-${field.key}`}>{field.label}</Label>
        {field.options ? <SelectField id={`${service}-${field.key}`} value={String(draft[field.key])} onValueChange={value => {
          if (field.key === 'protocol') applyProtocol(value); else setDraft({ ...draft, [field.key]: value });
        }}>
          {field.options.map(value => <option key={value} value={value}>{labels[value] ?? value}</option>)}
        </SelectField> : service === 'speech' && (field.key === 'model' || field.key === 'voice') ? (
          <SuggestInput
            id={`${service}-${field.key}`}
            value={String(draft[field.key])}
            onChange={value => setDraft({ ...draft, [field.key]: value })}
            options={(field.key === 'model' ? catalog?.models : catalog?.voices) ?? []}
            placeholder={field.placeholder}
            label={field.label}
          />
        ) : <Input id={`${service}-${field.key}`} type={field.min === undefined ? 'text' : 'number'} min={field.min} max={field.max} step={field.step}
          placeholder={field.key === 'base_url' ? (deepseek ? 'https://api.deepseek.com' : dashscope ? 'https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com' : field.placeholder) : field.placeholder}
          value={String(draft[field.key])}
          onChange={e => setDraft({ ...draft, [field.key]: field.min === undefined ? e.target.value : Number(e.target.value) })} />}
        {field.key === 'base_url' && service === 'speech' && <p className="hint">填写基础地址即可；完整语音接口地址也可识别。留空可停用合成。</p>}
      </div>)}</div>
      {service === 'speech' && catalog?.models && <p className="hint">模型来自{catalog.model_source === 'api' ? '阿里实时列表' : '内置列表'}（{catalog.models.length} 个）；音色为内置常用列表，复刻或设计音色可直接填 ID。</p>}
      {dashscope && <div className="field space-y-2 rounded-md border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="speech-instruction">默认朗读风格指令（可选，支持 Qwen-Audio 3.x 与 CosyVoice v3.5）</Label>
          <div className="flex flex-wrap gap-1">
            {SPEECH_INSTRUCTION_PRESETS.map(preset => (
              <Button
                key={preset.id}
                type="button"
                size="xs"
                variant={String(draft.instruction ?? '') === preset.text ? 'secondary' : 'outline'}
                onClick={() => setDraft({ ...draft, instruction: preset.text })}
              >
                {preset.label}
              </Button>
            ))}
            {Boolean(draft.instruction) && (
              <Button type="button" size="xs" variant="ghost" onClick={() => setDraft({ ...draft, instruction: '' })}>
                清空
              </Button>
            )}
          </div>
        </div>
        <Input
          id="speech-instruction"
          maxLength={200}
          placeholder="留空则跟随音色默认表现；点上方预设可一键填入自然授课或流畅明快指令"
          value={String(draft.instruction ?? '')}
          onChange={e => setDraft({ ...draft, instruction: e.target.value })}
        />
        <p className="hint">会对系统音色与复刻音色同时生效；单个课件里教师也可以单独覆盖朗读语气。</p>
      </div>}
      <div className="field max-w-lg"><Label htmlFor={`${service}-key`}>API Key {saved?.key_configured ? '（已配置）' : '（未配置）'}</Label>
        <Input id={`${service}-key`} type="password" autoComplete="new-password" value={key} placeholder={saved?.key_configured ? '••••••••' : '填写服务密钥'} disabled={clearKey} onChange={e => setKey(e.target.value)} />
        <Label className="mt-2 gap-2"><Checkbox checked={clearKey} onCheckedChange={value => { setClearKey(!!value); setKey(''); }} />清除已保存密钥</Label>
      </div>
      {deepseek && <p className="hint">学生播放时仍可调速。<a className="underline" href="https://api-docs.deepseek.com/zh-cn/guides/tts/" target="_blank" rel="noreferrer">查看接口说明</a></p>}
    </fieldset>}
  </section>;
}
