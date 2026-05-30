import { describe, expect, it } from 'vitest';
import { parseCqString } from '../src/converters/ob11/cq-codes';

describe('parseCqString', () => {
  it('returns a single text segment for plain text', async () => {
    const out = await parseCqString('hello world');
    expect(out).toEqual([{ type: 'text', data: { text: 'hello world' } }]);
  });

  it('returns empty array for empty input', async () => {
    const out = await parseCqString('');
    expect(out).toEqual([]);
  });

  it('decodes HTML entities in text', async () => {
    const out = await parseCqString('a&amp;b&#91;c&#93;d&#44;e');
    expect(out).toEqual([{ type: 'text', data: { text: 'a&b[c]d,e' } }]);
  });

  it('parses [CQ:face,id=178] as a face segment', async () => {
    const out = await parseCqString('[CQ:face,id=178]');
    expect(out).toEqual([{ type: 'face', data: { id: 178 } }]);
  });

  it('parses [CQ:reply,id=...] as a reply segment', async () => {
    const out = await parseCqString('[CQ:reply,id=1234567890]');
    expect(out).toEqual([{ type: 'reply', data: { id: '1234567890' } }]);
  });

  it('parses [CQ:at,qq=all] as an at-all segment', async () => {
    const out = await parseCqString('[CQ:at,qq=all]');
    expect(out).toEqual([{ type: 'at', data: { uid: 'all' } }]);
  });

  it('resolves at-uin via supplied resolver', async () => {
    const resolver = async (uin: string) => (uin === '12345' ? { uid: 'u_test_uid' } : null);
    const out = await parseCqString('[CQ:at,qq=12345]', resolver);
    expect(out).toEqual([{ type: 'at', data: { uid: 'u_test_uid', uin: '12345' } }]);
  });

  it('uses resolver-supplied nick as the at name when not overridden', async () => {
    const resolver = async (uin: string) => (uin === '42' ? { uid: 'u_x', nick: 'Bob' } : null);
    const out = await parseCqString('[CQ:at,qq=42]', resolver);
    expect(out).toEqual([{ type: 'at', data: { uid: 'u_x', uin: '42', name: 'Bob' } }]);
  });

  it('preserves explicit at name= param over resolver-supplied nick', async () => {
    const resolver = async () => ({ uid: 'u_aaa', nick: 'WhateverTheResolverSays' });
    const out = await parseCqString('[CQ:at,qq=1,name=alice]', resolver);
    expect(out).toEqual([{ type: 'at', data: { uid: 'u_aaa', uin: '1', name: 'alice' } }]);
  });

  it('falls back to literal @<num> text when at-uin resolution misses', async () => {
    const resolver = async () => null;
    const out = await parseCqString('[CQ:at,qq=99999]', resolver);
    expect(out).toEqual([{ type: 'text', data: { text: '@99999 ' } }]);
  });

  it('falls back to literal @<num> text when no resolver is provided', async () => {
    const out = await parseCqString('[CQ:at,qq=99999]');
    expect(out).toEqual([{ type: 'text', data: { text: '@99999 ' } }]);
  });

  it('parses [CQ:image,file=...] as an image segment', async () => {
    const out = await parseCqString('[CQ:image,file=abc123.jpg]');
    expect(out).toEqual([{ type: 'image', data: { file: 'abc123.jpg' } }]);
  });

  it('parses image with file + url + summary', async () => {
    const out = await parseCqString('[CQ:image,file=md5xxx,url=http://example.com/img.jpg,summary=cat]');
    expect(out).toEqual([{
      type: 'image',
      data: { file: 'md5xxx', url: 'http://example.com/img.jpg', summary: 'cat' },
    }]);
  });

  it('handles mixed text and CQ codes in order', async () => {
    const resolver = async (uin: string) => (uin === '123' ? { uid: 'u_a' } : null);
    const out = await parseCqString('hello [CQ:at,qq=123] world [CQ:face,id=1] !', resolver);
    expect(out).toEqual([
      { type: 'text', data: { text: 'hello ' } },
      { type: 'at',   data: { uid: 'u_a', uin: '123' } },
      { type: 'text', data: { text: ' world ' } },
      { type: 'face', data: { id: 1 } },
      { type: 'text', data: { text: ' !' } },
    ]);
  });

  it('preserves unknown CQ types verbatim as text', async () => {
    const out = await parseCqString('[CQ:vibe,quality=10]');
    expect(out).toEqual([{ type: 'text', data: { text: '[CQ:vibe,quality=10]' } }]);
  });

  it('handles unterminated [CQ: as literal text', async () => {
    const out = await parseCqString('hello [CQ:at,qq=123');
    expect(out).toEqual([
      { type: 'text', data: { text: 'hello ' } },
      { type: 'text', data: { text: '[CQ:at,qq=123' } },
    ]);
  });

  it('decodes escapes inside CQ param values', async () => {
    const out = await parseCqString('[CQ:image,file=abc&#44;d&#91;e&#93;f]');
    expect(out).toEqual([{ type: 'image', data: { file: 'abc,d[e]f' } }]);
  });
});
