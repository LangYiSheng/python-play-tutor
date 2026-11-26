import { render } from "./render-with-toasts";
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AssistantModelSettings } from '../src/components/assistant-model-settings';
import { api } from '../src/lib/api';

vi.mock('../src/lib/drafts', () => ({ useDraft: vi.fn() }));
vi.mock('../src/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() }, errorMessage: (e: Error) => e.message }));
const settings = { revision: 1, base_url: 'https://example.invalid/v1', model: 'fixture', reasoning_effort: '', context_window: 32768,
  compression_threshold: 24576, output_tokens: 2048, model_calls: 6, tool_calls: 12, timeout_seconds: 120, request_tokens: 262144,
  user_daily_requests: 12, key_configured: true, key_mask: '••••••••', source: 'database', token_counting: '保守估算' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue(settings); });
it('keeps the key masked and only tests a saved connection on explicit click', async () => {
  vi.mocked(api.post).mockResolvedValue({ elapsed_ms: 12, tokens: 4 });
  render(<AssistantModelSettings />);
  await screen.findByDisplayValue('fixture');
  expect(api.post).not.toHaveBeenCalled();
  const key = screen.getByLabelText('API Key （已配置）') as HTMLInputElement;
  expect(key.value).toBe(''); expect(key.type).toBe('password');
  fireEvent.click(screen.getByText('测试已保存连接'));
  await screen.findByText('连接正常');
  expect(screen.getByText('12 ms · 4 tokens')).toBeVisible();
  expect(api.post).toHaveBeenCalledWith('/teacher/assistant/model/test', {});
});
it('preserves an unsaved key on failure and clears it after successful save', async () => {
  vi.mocked(api.put).mockRejectedValueOnce(new Error('设置冲突')).mockResolvedValueOnce({ ...settings, revision: 2 });
  render(<AssistantModelSettings />);
  await screen.findByDisplayValue('fixture');
  const key = screen.getByLabelText('API Key （已配置）') as HTMLInputElement;
  fireEvent.change(key, { target: { value: 'test-only-key' } });
  fireEvent.click(screen.getByText('保存设置'));
  await screen.findByText('设置冲突'); expect(key.value).toBe('test-only-key');
  fireEvent.click(screen.getByText('保存设置'));
  await waitFor(() => expect(key.value).toBe(''));
  expect(api.post).not.toHaveBeenCalled();
});

it('saves the per-student daily limit independently from the per-request budget', async () => {
  vi.mocked(api.put).mockResolvedValue({ ...settings, revision: 2, user_daily_requests: 24 });
  render(<AssistantModelSettings />);
  const limit = await screen.findByRole('spinbutton', { name: '每名学生每日提问上限' });
  const save = screen.getByRole('button', { name: '保存设置' });
  expect(limit).toHaveValue(12);
  for (const value of ['', '-1', '1.5']) {
    fireEvent.change(limit, { target: { value } });
    expect(save).toBeDisabled();
  }
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.change(limit, { target: { value: '24' } });
  fireEvent.click(save);
  await screen.findByText('设置已保存');
  expect(api.put).toHaveBeenCalledWith('/teacher/assistant/model', expect.objectContaining({
    expected_revision: 1, user_daily_requests: 24, request_tokens: settings.request_tokens,
  }));
  expect(limit).toHaveValue(24);
  expect(save).toBeDisabled();
  expect(api.post).not.toHaveBeenCalled();
});
