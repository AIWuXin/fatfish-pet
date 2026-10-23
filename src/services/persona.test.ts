import { describe, expect, it } from 'vitest';
import { parseReply, stripPartialMarkers } from './persona';

describe('parseReply', () => {
  it('剥掉 mood 标记', () => {
    const r = parseReply('你好呀 [[mood:happy]]');
    expect(r.text).toBe('你好呀');
    expect(r.mood).toBe('happy');
    expect(r.remember).toBeUndefined();
  });

  it('剥掉 remember 标记', () => {
    const r = parseReply('记住了 [[remember:他喜欢冰美式]]');
    expect(r.text).toBe('记住了');
    expect(r.remember).toBe('他喜欢冰美式');
  });

  it('两个标记同时存在', () => {
    const r = parseReply('好 [[mood:shy]] [[remember:他生日是 3 月 2 日]]');
    expect(r.text).toBe('好');
    expect(r.mood).toBe('shy');
    expect(r.remember).toBe('他生日是 3 月 2 日');
  });

  it('没有标记时原样返回', () => {
    const r = parseReply('就一句普通的话');
    expect(r.text).toBe('就一句普通的话');
    expect(r.mood).toBeUndefined();
    expect(r.remember).toBeUndefined();
  });
});

describe('stripPartialMarkers', () => {
  it('藏掉没闭合的标记尾巴', () => {
    expect(stripPartialMarkers('你好 [[mood:ha')).toBe('你好');
  });

  it('没有标记时不动', () => {
    expect(stripPartialMarkers('正常文本')).toBe('正常文本');
  });
});
