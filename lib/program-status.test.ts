import { afterEach, describe, expect, test } from 'bun:test';
import { Ghostty } from './ghostty';
import { Terminal } from './terminal';
import type { ProgramStatusReport } from './types';

const query = '\x1b]7501;?\x1b\\';
const terminals: Terminal[] = [];

async function open(ghostty?: Ghostty) {
  const term = new Terminal({ ghostty: ghostty ?? (await Ghostty.load()), cols: 20, rows: 4 });
  terminals.push(term);
  await term.open(document.createElement('div'));
  return term;
}

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});

describe('OSC 7501', () => {
  test('advertises support only while subscribed, including before open and after reset', async () => {
    const term = new Terminal({ ghostty: await Ghostty.load() });
    terminals.push(term);
    const reports: ProgramStatusReport[] = [];
    const subscription = term.onProgramStatus((report) => reports.push(report));
    await term.open(document.createElement('div'));
    const replies: string[] = [];
    term.onData((data) => replies.push(data));
    term.write(query);
    expect(replies).toEqual([query]);
    expect(reports).toEqual([]);
    term.reset();
    expect(reports.map((r) => r.state)).toEqual(['clear']);
    term.write(query);
    expect(replies).toEqual([query, query]);
    subscription.dispose();
    subscription.dispose();
    term.write(query);
    expect(replies).toHaveLength(2);
  });

  test('copies decoded reports across chunked byte/string writes, BEL and ST', async () => {
    const term = await open();
    const reports: ProgramStatusReport[] = [];
    term.onProgramStatus((report) => reports.push(report));
    term.write('\x1b]750');
    term.write(
      new TextEncoder().encode(
        '1;state=blocked:kind=permission:progress=40:id=a/b:app=terraform:title=UGxhbg==:msg=QXBwbHk/'
      )
    );
    expect(reports).toEqual([]);
    term.write('\x07');
    expect(reports).toEqual([
      {
        state: 'blocked',
        kind: 'permission',
        progress: 40,
        id: 'a/b',
        app: 'terraform',
        title: 'Plan',
        message: 'Apply?',
      },
    ]);
    term.write('\x1b]7501;state=done\x1b\\');
    expect(reports[1]).toEqual({
      state: 'done',
      kind: null,
      progress: null,
      id: '',
      app: '',
      title: '',
      message: '',
    });
    term.write('ordinary output');
    expect(reports[0].message).toBe('Apply?');
    term.write('\x1bc');
    expect(reports.at(-1)?.state).toBe('clear');
    expect(reports.at(-1)?.id).toBe('');
  });

  test('routes shared-module terminals independently and handles multiple subscriptions', async () => {
    const ghostty = await Ghostty.load();
    const a = await open(ghostty);
    const b = await open(ghostty);
    const reports: ProgramStatusReport[] = [];
    const replies: string[] = [];
    b.onData((data) => replies.push(data));
    b.write(query);
    expect(replies).toEqual([]);
    const first = a.onProgramStatus((report) => reports.push(report));
    const second = a.onProgramStatus(() => {});
    first.dispose();
    a.onData((data) => replies.push(data));
    a.write(query);
    expect(replies).toEqual([query]);
    b.write('\x1b]7501;state=working\x07');
    expect(reports).toEqual([]);
    second.dispose();
    a.write(query);
    expect(replies).toHaveLength(1);
    b.onProgramStatus((report) => reports.push(report));
    b.write('\x1b]7501;state=clear:id=parent/child\x07');
    expect(reports[0]).toMatchObject({ state: 'clear', id: 'parent/child' });
  });

  test('ignores invalid reports and delivers UTF-8 messages without rendering them', async () => {
    const term = await open();
    const reports: ProgramStatusReport[] = [];
    term.onProgramStatus((report) => reports.push(report));
    term.write('\x1b]7501;state=bogus\x07');
    expect(reports).toEqual([]);
    const message = 'Ready ✓';
    term.write(`\x1b]7501;state=idle:msg=${Buffer.from(message).toString('base64')}\x1b\\`);
    expect(reports[0].message).toBe(message);
    expect(term.wasmTerm!.getCursor()).toMatchObject({ x: 0, y: 0 });
  });

  test('allows listeners to write and dispose after leaving the WASM callback', async () => {
    const term = await open();
    term.onProgramStatus(() => {
      term.write('ok');
      term.dispose();
    });
    expect(() => term.write('\x1b]7501;state=done\x07')).not.toThrow();
  });
});
