import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { Command } from '@opencode/plugin/gui';
import * as solid from 'solid-js';
import * as effect from 'effect';
import * as gui from '@opencode/plugin/gui';
import fs from 'node:fs';
import vm from 'node:vm';
import { completionModel, setupPromptCompletion } from '../../src/desktop/prompts';

const adapter = vi.hoisted(() => ({ eligible: true, editor: undefined as HTMLElement | undefined, visible: false, text: '' }));
vi.mock('../../src/desktop/prompt-editor.mjs', () => ({
  promptEditorSnapshot: (composer: any, options: any) => ({ editor: adapter.editor, viewport: adapter.editor?.parentElement, prefix: composer?.text() || '',
    eligible: adapter.eligible && !options.composing && !!composer?.focused() && composer?.quotable(), reason: adapter.eligible ? 'ready' : 'caret-not-at-end' }),
  createPromptGhost: () => ({ update: (snapshot: any, text: string) => { adapter.visible = snapshot.eligible && !!text; adapter.text = adapter.visible ? text : ''; return adapter.visible; },
    clear: () => { adapter.visible = false; adapter.text = ''; }, dispose: () => { adapter.visible = false; adapter.text = ''; }, get visible() { return adapter.visible; } }),
}));

const cleanup: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); adapter.eligible = true; adapter.visible = false; adapter.text = ''; });
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers(); document.body.innerHTML = ''; });
const advance = (ms = 120) => vi.advanceTimersByTimeAsync(ms);

function host(options: { automatic?: boolean; generate?: any; prefix?: string; model?: string; bundled?: boolean } = {}) {
  const [text, setText] = createSignal(options.prefix ?? 'Проверь');
  const [focused, setFocused] = createSignal(true);
  const [messages, setMessages] = createSignal<any[]>([{ type: 'user', content: [{ type: 'text', text: 'Предыдущее задание' }] }]);
  const [running, setRunning] = createSignal(false);
  const form = document.createElement('form'); form.dataset.component = 'composer';
  const viewport = document.createElement('div'); viewport.dataset.component = 'composer-scroll';
  const editor = document.createElement('div'); editor.tabIndex = 0; editor.dataset.component = 'composer-editor';
  editor.setAttribute('contenteditable', 'true'); editor.setAttribute('aria-multiline', 'true'); editor.textContent = text();
  viewport.append(editor); form.append(viewport); document.body.append(form); editor.focus(); adapter.editor = editor;
  const caret = document.createRange(); caret.selectNodeContents(editor); caret.collapse(false);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(caret);
  const mentions = [{ type: 'file', path: 'src/main.kt' }];
  const insert = vi.fn((suffix: string) => setText(value => value + suffix));
  const setModel = vi.fn(), setTextAPI = vi.fn(), prompt = vi.fn(), alert = vi.fn();
  const generate = vi.fn(options.generate || (() => Promise.resolve({ text: '{"suggestion":" новый тест"}' })));
  const makeSession = (id: string): any => ({ id, key: `server:${id}`, directory: `/arc/${id}`, location: { directory: `/arc/${id}` },
    server: { id: 'server', client: { generate: { text: generate }, session: { prompt } }, data: {
      listen: () => () => {}, location: { model: { list: () => [{ id: 'deepseek-v4.1-flash', providerID: 'opencode-go', enabled: true, variants: [{ id: 'none' }] }] } },
      session: { status: () => running() ? 'running' : 'idle', message: { list: messages } },
    } } });
  const [session, setSession] = createSignal(makeSession('a'));
  const contributions: any[] = [];
  const ctx: any = { options: { promptCompletion: { enabled: true, automatic: options.automatic ?? true, typingDebounceMs: 100, cooldownMs: 0, timeoutMs: 1000,
    predictionModel: options.model ?? 'opencode-go/deepseek-v4.1-flash#none' } }, sessions: { current: session },
    screen: { current: () => ({ composer: { text, focused, focus: () => { setFocused(true); editor.focus(); }, quotable: () => true, model: () => ({ providerID: 'main', modelID: 'main', variant: 'high' }), insert, setText: setTextAPI, setModel } }) },
    storage: { store: (_key: string, options: any) => { const [value, set] = createSignal(options.initial); return { get value() { return value(); }, ready: () => true, set }; } },
    dialogs: { alert }, add: (token: any, item: any) => { if (token === Command) contributions.push(item); } };
  let api!: ReturnType<typeof setupPromptCompletion>;
  createRoot(dispose => {
    cleanup.push(dispose);
    if (options.bundled) {
      const module = { exports: {} as any };
      const shared: Record<string, unknown> = { 'solid-js': solid, effect, '@opencode/plugin/gui': gui, 'node:crypto': {} };
      vm.runInNewContext(fs.readFileSync('dist/gui-experimental.cjs', 'utf8'), {
        module, exports: module.exports, document, window, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
        require: (name: string) => {
          if (!(name in shared)) throw new Error(`Unexpected bundled dependency: ${name}`);
          return shared[name];
        },
      });
      module.exports.default.setup(ctx);
    } else api = setupPromptCompletion(ctx);
  });
  const key = (name: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }); editor.dispatchEvent(event); return event;
  };
  const command = (id: string) => contributions.map(item => typeof item === 'function' ? item() : item).find(item => item.id === id);
  return { api, text, setText, focused, setFocused, setMessages, setRunning, setSession, makeSession, generate, insert, mentions, setTextAPI, setModel, prompt, editor, key, command, alert };
}

it('parses string and object model overrides without changing the main composer model', () => {
  expect(completionModel('opencode-go/deepseek-v4.1-flash#none')).toEqual({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', variant: 'none' });
  expect(completionModel({ providerID: 'x', id: 'namespace/model' })).toEqual({ providerID: 'x', id: 'namespace/model' });
  expect(completionModel('bad')).toBeUndefined();
});

it('the shipped CommonJS GUI works with host modules and inert Node crypto', async () => {
  const h = host({ bundled: true }); await advance();
  expect(h.generate).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-prompt-ghost-suffix]')?.textContent).toBe(' новый тест');
  expect(h.key('Tab').defaultPrevented).toBe(true);
  expect(h.insert).toHaveBeenCalledWith(' новый тест');
  expect(h.prompt).not.toHaveBeenCalled();
});

it('debounces a stateless prediction and accepts it with Tab using insert, never send/setText/setModel', async () => {
  const h = host(); await advance(90); expect(h.generate).not.toHaveBeenCalled(); await advance(20);
  expect(h.generate).toHaveBeenCalledTimes(1); expect(adapter.text).toBe(' новый тест');
  expect(h.generate.mock.calls[0][0].model.variant).toBe('none');
  expect(h.key('Tab').defaultPrevented).toBe(true);
  expect(h.text()).toBe('Проверь новый тест'); expect(h.insert).toHaveBeenCalledWith(' новый тест');
  expect(h.mentions).toEqual([{ type: 'file', path: 'src/main.kt' }]);
  expect(h.setTextAPI).not.toHaveBeenCalled(); expect(h.setModel).not.toHaveBeenCalled(); expect(h.prompt).not.toHaveBeenCalled();
});

it('accepts one word and keeps the remaining suffix from cache', async () => {
  const h = host(); await advance();
  expect(h.key('ArrowRight', { altKey: true }).defaultPrevented).toBe(true); await advance(0);
  expect(h.text()).toBe('Проверь новый'); expect(adapter.text).toBe(' тест');
  h.key('Tab'); await advance(200);
  expect(h.text()).toBe('Проверь новый тест'); expect(h.generate).toHaveBeenCalledTimes(1);
});

it('leaves Tab and Enter alone when no valid visible suggestion exists', async () => {
  const h = host(); adapter.eligible = false; await advance();
  expect(h.key('Tab').defaultPrevented).toBe(false); expect(h.key('Enter').defaultPrevented).toBe(false);
  expect(h.generate).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
});

it('hides suggestions during IME, blur and native popup/caret ineligibility', async () => {
  const h = host(); await advance(); expect(adapter.visible).toBe(true);
  h.editor.dispatchEvent(new Event('compositionstart', { bubbles: true })); await advance(0); expect(adapter.visible).toBe(false);
  expect(h.key('Tab', { isComposing: true }).defaultPrevented).toBe(false);
  h.editor.dispatchEvent(new Event('compositionend', { bubbles: true })); await advance(0); expect(adapter.visible).toBe(true);
  h.setFocused(false); h.api.refresh(); expect(adapter.visible).toBe(false);
  h.setFocused(true); adapter.eligible = false; h.api.refresh(); expect(h.key('Tab').defaultPrevented).toBe(false);
});

it('dismisses with Escape without restarting the same draft automatically', async () => {
  const h = host(); await advance(); expect(h.key('Escape').defaultPrevented).toBe(true); await advance(1000);
  expect(adapter.visible).toBe(false); expect(h.generate).toHaveBeenCalledTimes(1);
});

it('cancels and ignores a late prediction after switching the routed directory/session', async () => {
  let finish!: (value: any) => void;
  const h = host({ generate: () => new Promise(resolve => { finish = resolve; }) }); await advance();
  const first = finish, signal = h.generate.mock.calls[0][1].signal;
  h.setSession(h.makeSession('b')); await advance(0);
  expect(signal.aborted).toBe(true);
  first({ text: '{"suggestion":" wrong workspace"}' }); await advance(0);
  expect(adapter.text).not.toContain('wrong workspace'); expect(h.insert).not.toHaveBeenCalled();
});

it('does not send slash/shell commands or overlong drafts', async () => {
  const h = host({ prefix: '/command' }); await advance(); expect(h.generate).not.toHaveBeenCalled();
  for (const text of ['!pwd', 'x'.repeat(2001)]) { h.setText(text); await advance(); }
  expect(h.generate).not.toHaveBeenCalled();
});

it('can complete a draft beginning with an already resolved mention', async () => {
  const h = host({ prefix: '@main.kt проверь' }); await advance();
  expect(h.generate).toHaveBeenCalledTimes(1);
  h.key('Tab'); expect(h.text()).toBe('@main.kt проверь новый тест'); expect(h.setTextAPI).not.toHaveBeenCalled();
});

it('manual mode makes no automatic requests and exposes metadata-only diagnostics', async () => {
  const h = host({ automatic: false }); await advance(1000); expect(h.generate).not.toHaveBeenCalled();
  h.command('prompt-completion.generate').run(); await advance(0); expect(h.generate).toHaveBeenCalledTimes(1);
  h.command('prompt-completion.status').run();
  expect(h.alert.mock.calls[0][0].description).not.toContain('Проверь'); expect(h.prompt).not.toHaveBeenCalled();
});

it('fails closed for a configured model or variant absent from the connected server', async () => {
  const h = host({ model: 'opencode-go/deepseek-v4.1-flash#missing' }); await advance(1000);
  expect(h.generate).not.toHaveBeenCalled(); expect(h.key('Tab').defaultPrevented).toBe(false);
});

it('excludes tools/reasoning and streaming assistant text from prediction context', async () => {
  const h = host();
  h.setRunning(true);
  h.setMessages([{ type: 'user', text: 'completed request' }, { type: 'assistant', parts: [{ type: 'reasoning', text: 'private-reasoning' },
    { type: 'tool', text: 'private-tool' }, { type: 'text', text: 'streaming-partial' }] }]);
  await advance();
  const prompt = h.generate.mock.calls[0][0].prompt;
  expect(prompt).toContain('completed request'); expect(prompt).not.toContain('streaming-partial');
  expect(prompt).not.toContain('private-reasoning'); expect(prompt).not.toContain('private-tool');
});

it('cleanup aborts the request, removes key handlers and leaves native keys untouched', async () => {
  const h = host({ generate: () => new Promise(() => {}) }); await advance();
  const signal = h.generate.mock.calls[0][1].signal;
  h.api.dispose(); expect(signal.aborted).toBe(true); expect(h.key('Tab').defaultPrevented).toBe(false);
  await advance(2000); expect(h.generate).toHaveBeenCalledTimes(1); expect(adapter.visible).toBe(false);
});
