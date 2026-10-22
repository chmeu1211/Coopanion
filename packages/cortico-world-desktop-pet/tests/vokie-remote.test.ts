/**
 * The Vokie remote through the World: holding its voice key talks to Coo over the same talk-key
 * path the microphone uses, and a tap sends nothing. The remote itself is a scripted source, so
 * no log file and no hardware are involved; the recognizer is the same stand-in `voice.test.ts`
 * uses for sherpa-onnx.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DESKTOP_PET_DEFAULTS } from '../src/config.ts';
import { DesktopPetWorld } from '../src/world.ts';
import type { ModelSpec } from '../src/runtime/store.ts';
import type { RemoteEdge } from '../src/vokie/gesture.ts';
import type { VokieRecord } from '../src/vokie/records.ts';
import type { SherpaModule } from '../src/asr/sherpa.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { FakePage } from './helpers/page.ts';

const MODEL = Buffer.from('model');
const TOKENS = Buffer.from('tokens');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function fakeFunAsr(text: string): SherpaModule {
  return {
    OfflineRecognizer: {
      createAsync: async () => ({
        createStream: () => ({ samples: 0, acceptWaveform: () => {} }),
        decodeAsync: async () => ({ text }),
      }),
    },
  } as unknown as SherpaModule;
}

const modelSpec = (): ModelSpec => ({
  id: 'test-model',
  files: [{ role: 'model', name: 'model.int8.onnx', bytes: MODEL.length, sha256: sha(MODEL) }, { role: 'tokens', name: 'tokens.txt', bytes: TOKENS.length, sha256: sha(TOKENS) }],
  sources: [],
});

function placeModels(modelsDir: string): ModelSpec {
  mkdirSync(join(modelsDir, 'test-model'), { recursive: true });
  writeFileSync(join(modelsDir, 'test-model', 'model.int8.onnx'), MODEL);
  writeFileSync(join(modelsDir, 'test-model', 'tokens.txt'), TOKENS);
  const files = ['encoder', 'decoder', 'tokens'].map((role) => ({ role, name: `${role}.bin`, body: Buffer.from(role) }));
  mkdirSync(join(modelsDir, 'test-whisper'), { recursive: true });
  for (const file of files) writeFileSync(join(modelsDir, 'test-whisper', file.name), file.body);
  return { id: 'test-whisper', files: files.map(({ role, name, body }) => ({ role, name, bytes: body.length, sha256: sha(body) })), sources: [] };
}

const tone = (ms: number, amp: number): Int16Array[] => {
  const frames: Int16Array[] = [];
  for (let f = 0; f < ms / 20; f++) {
    const fr = new Int16Array(320);
    for (let i = 0; i < 320; i++) fr[i] = Math.round(amp * 32767 * Math.sin(2 * Math.PI * 440 * (f * 320 + i) / 16000));
    frames.push(fr);
  }
  return frames;
};

const VOICE: Omit<RemoteEdge, 'down' | 'ts'> = { button: 'voice', page: 0x0c, usage: 0x221 };

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(heard = '帮我看看这个') {
  const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
  Object.assign(cfg, { enabled: true, port: 0 });
  cfg.window.enabled = false;
  cfg.asr.mic.mode = 'hold';
  // keys are never injected in a test, and 200 ms keeps a hold short
  cfg.vokie.remote = { enabled: true, source: 'log', holdMs: 200, stopDictation: false };
  const dir = mkdtempSync(join(tmpdir(), 'pet-remote-'));
  const whisperModel = placeModels(join(dir, 'm'));
  const remote = { started: 0, stopped: 0, start() { remote.started++; }, stop() { remote.stopped++; } };
  const records = { started: 0, stopped: 0, start() { records.started++; }, stop() { records.stopped++; } };
  let feed: ((edge: RemoteEdge) => void) | null = null;
  let feedRecord: ((record: VokieRecord) => void) | null = null;
  const world = new DesktopPetWorld({
    cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => join(dir, 'rt'), modelsDir: () => join(dir, 'm'),
    openRemote: (onEdge) => { feed = onEdge; return remote; },
    openRecords: (onRecord) => { feedRecord = onRecord; return records; },
    loadSherpa: () => fakeFunAsr(heard), funasrModel: modelSpec(), whisperModel, language: () => 'zh',
  });
  const host = new FakeHost();
  await world.start(host);
  cleanup.push(() => world.stop());
  await expect.poll(() => (world.voiceState().server as { phase: string }).phase).toBe('running');
  const page = await FakePage.open(world.petUrl.replace(/\/pet$/, ''));
  cleanup.push(() => page.close());
  const down = () => void feed?.({ ...VOICE, down: true, ts: Date.now() });
  const up = () => void feed?.({ ...VOICE, down: false, ts: Date.now() });
  const emitRecord = (text: string) => void feedRecord?.({ id: 7, type: 'toggle', text, ts: Date.now() });
  return { world, host, page, remote, records, down, up, emitRecord };
}

describe('Vokie remote', () => {
  it('listens while the voice key is held and sends what it heard when it is let go', async () => {
    const { world, host, page, remote, down, up } = await setup();
    expect(remote.started).toBe(1);
    down();
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    // past holdMs, the hold is decided by the World's own tick; the pet keeps listening either way
    await new Promise((r) => setTimeout(r, 300));
    for (const fr of tone(600, .3)) page.audio(fr);
    // the frames travel over the socket; releasing before they arrive would flush an empty sentence
    await new Promise((r) => setTimeout(r, 200));
    up();
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-pet.speech', senderKey: 'desktop-pet.voice', text: '[voice] 伙伴:帮我看看这个' });
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
  });

  it('sends nothing for a tap: that one belongs to Vokie', async () => {
    const { host, page, down, up } = await setup();
    down();
    await page.next((m) => m.t === 'listen' && m.phase === 'start');
    for (const fr of tone(100, .3)) page.audio(fr);
    up();
    // the listening bubble closes without a `heard` phase and the bot is not woken
    await page.next((m) => m.t === 'listen' && m.phase === 'none');
    expect(host.events).toHaveLength(0);
  });

  it('stops watching when the World stops', async () => {
    const { world, remote, down } = await setup();
    await world.stop();
    await expect.poll(() => remote.stopped).toBe(1);
    down();
    expect(world.voiceState().counts).toMatchObject({ utterances: 0 });
  });
});

describe('Vokie 旁听 channel', () => {
  it('turns one finished session from Vokie into one speech event', async () => {
    const { host, page, records, emitRecord } = await setup();
    expect(records.started).toBe(1);
    emitRecord('帮我把窗口挪到右边');
    await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
    expect(host.events[0]).toMatchObject({ type: 'desktop-pet.speech', senderKey: 'desktop-pet.voice', text: '[voice] 伙伴:帮我把窗口挪到右边' });
    expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
    expect((await page.next((m) => m.t === 'listen' && m.phase === 'heard')).text).toBe('帮我把窗口挪到右边');
  });

  it('stops reading Vokie when the World stops', async () => {
    const { world, records } = await setup();
    await world.stop();
    await expect.poll(() => records.stopped).toBe(1);
  });
});
