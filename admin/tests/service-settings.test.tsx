import { render } from "./render-with-toasts";
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { GlobalSettings } from '../src/features/management/settings';
import { ServiceSettings } from '../src/components/service-settings';
import { api } from '../src/lib/api';
import { SPEECH_INSTRUCTION_PRESETS } from '../src/lib/voice-api';

vi.mock('../src/lib/drafts', () => ({ useDraft: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() }, errorMessage: (e: Error) => e.message }));
const config = { revision: 0, base_url: 'https://example.invalid', model: 'writer', vision_model: 'vision', effort: 'none', max_tokens: 8000, timeout: 120, daily_pages: 300, key_configured: true, source: 'environment' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async path => path.includes('/course/settings') ? { revision: 1, assistant: { enabled: true }, roles: [] } : config);
});
it('retains service drafts across icon tabs', async () => {
  const w = render(<GlobalSettings />);
  await screen.findByRole('button', { name: '测试已保存连接' });
  const tab = screen.getByRole('tab', { name: '讲稿生成' });
  expect(tab.querySelector('svg')).not.toBeNull();
  fireEvent.click(tab);
  const input = await screen.findByLabelText('页面图像模型');
  fireEvent.change(input, { target: { value: 'unsaved-vision' } });
  fireEvent.click(screen.getByRole('tab', { name: '学生助教' }));
  fireEvent.click(tab);
  expect(screen.getByLabelText('页面图像模型')).toHaveValue('unsaved-vision');
  expect(tab).toHaveAccessibleDescription('未保存');
  expect(api.put).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  w.unmount();
});
it('shows the settings categories as a compact vertical list without a top page header', async () => {
  const { container } = render(<GlobalSettings />);
  expect(container.querySelector('.page-heading')).toBeNull();
  const list = screen.getByRole('tablist', { name: '全站设置分类' });
  expect(list).toHaveAttribute('aria-orientation', 'vertical');
  expect(within(list).getAllByRole('tab')).toHaveLength(4);
  await waitFor(() => expect(screen.getByRole('tab', { name: '讲稿生成' })).toHaveAccessibleDescription('已配置'));
  expect(screen.getByRole('tab', { name: '语音合成' })).toHaveAccessibleDescription('待完善');
});
it('preserves keys after a conflict and clears transient key text only after save', async () => {
  vi.mocked(api.put).mockRejectedValueOnce(new Error('版本冲突')).mockResolvedValueOnce({ ...config, revision: 1 });
  render(<ServiceSettings service="authoring" />);
  const key = await screen.findByLabelText('API Key');
  expect(key).toHaveValue('');
  expect(screen.queryByRole('button', { name: '保存设置' })).toBeNull();
  fireEvent.change(key, { target: { value: 'fixture-key' } });
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  await screen.findByText('版本冲突');
  expect(key).toHaveValue('fixture-key');
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  await waitFor(() => expect(key).toHaveValue(''));
  expect(await screen.findByText('设置已保存')).toBeVisible();
  expect(screen.queryByRole('button', { name: '保存设置' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps primary settings visible and collapses advanced fields by default', async () => {
  render(<ServiceSettings service="authoring" />);
  expect(await screen.findByLabelText('API 地址')).toBeVisible();
  expect(screen.getByLabelText('页面图像模型')).toBeVisible();
  expect(screen.queryByRole('spinbutton', { name: '每次回复上限（tokens）' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /高级设置/ }));
  expect(screen.getByRole('spinbutton', { name: '每次回复上限（tokens）' })).toHaveValue(8000);
});

it('shows the sticky bottom action bar only while editing the active tab and saves only that tab', async () => {
  vi.mocked(api.put).mockResolvedValue({ ...config, revision: 2 });
  render(<GlobalSettings />);
  await screen.findByRole('button', { name: '测试已保存连接' });
  expect(screen.queryByRole('button', { name: '保存设置' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: '讲稿生成' }));
  expect(screen.queryByRole('button', { name: '保存设置' })).toBeNull();
  fireEvent.change(within(screen.getByRole('tabpanel', { name: '讲稿生成' })).getByLabelText('模型名称'), { target: { value: 'draft-writer' } });
  const save = screen.getByRole('button', { name: '保存设置' });
  expect(save.closest('.settings-sticky-bar')).not.toBeNull();
  expect(screen.getAllByRole('button', { name: '取消编辑' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('tab', { name: '学生助教' }));
  expect(screen.queryByRole('button', { name: '保存设置' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: '讲稿生成' }));
  fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.put).mock.calls[0][0]).toBe('/teacher/services/authoring');
});

it.each([['https://example.invalid', 'https://example.invalid'], ['https://api.openai.com/v1/', 'https://api.deepseek.com']])('fills protocol defaults from %s without changing credentials', async (baseUrl, expectedUrl) => {
  vi.mocked(api.get).mockResolvedValue({ ...config, base_url: baseUrl, protocol: 'openai', voice: 'custom-voice', format: 'mp3', speed: 1.5 });
  render(<ServiceSettings service="speech" />);
  const key = await screen.findByLabelText('API Key');
  fireEvent.change(key, { target: { value: 'unsaved-key' } });
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('语音接口协议'));
  await user.click(await screen.findByRole('option', { name: 'DeepSeek 工具语音接口' }));
  expect(screen.queryByLabelText('模型名称')).toBeNull();
  expect(screen.queryByLabelText('合成语速')).toBeNull();
  expect(screen.getByLabelText('API 地址')).toHaveValue(expectedUrl);
  expect(screen.getByLabelText('音色名称 / ID')).toHaveTextContent('Stella');
  expect(key).toHaveValue('unsaved-key');
  expect(api.put).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

it('lets dashscope speech settings apply an instruction preset and saves it', async () => {
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.includes('/speech/catalog')) {
      return { models: [{ id: 'qwen-audio-3.1-tts-flash', name: 'qwen-audio-3.1-tts-flash' }], voices: [], model_source: 'builtin', voice_source: 'builtin' };
    }
    return {
      revision: 3,
      protocol: 'dashscope',
      base_url: 'https://ws123.cn-beijing.maas.aliyuncs.com',
      model: 'qwen-audio-3.1-tts-flash',
      voice: 'longanhuan_v3.1',
      format: 'mp3',
      speed: 1,
      instruction: '',
      timeout: 60,
      key_configured: true,
      source: 'database',
    };
  });
  const fluentText = SPEECH_INSTRUCTION_PRESETS.find((p) => p.id === 'fluent')!.text;
  vi.mocked(api.put).mockResolvedValue({
    revision: 4,
    protocol: 'dashscope',
    base_url: 'https://ws123.cn-beijing.maas.aliyuncs.com',
    model: 'qwen-audio-3.1-tts-flash',
    voice: 'longanhuan_v3.1',
    format: 'mp3',
    speed: 1,
    instruction: fluentText,
    timeout: 60,
    key_configured: true,
    source: 'database',
  });

  render(<ServiceSettings service="speech" />);
  const user = userEvent.setup();
  const presetBtn = await screen.findByRole('button', { name: '流畅明快' });
  await user.click(presetBtn);
  const input = screen.getByLabelText(/默认朗读风格指令/);
  expect(input).toHaveValue(fluentText);

  await user.click(screen.getByRole('button', { name: '保存设置' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.put).mock.calls[0][1]).toMatchObject({
    instruction: fluentText,
  });
});
