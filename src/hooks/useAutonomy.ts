import { useCallback, useEffect, useRef, useState } from 'react';
import type { PetController } from '../live2d/pet-controller';
import {
  levelAtLeast,
  levelFor,
  pickIdleAction,
  proactiveChance,
  proactiveHint,
  randomInterval,
  SPEAK_COOLDOWN,
  wakeHint,
  type IdleAction,
  type IdleLevel,
} from '../services/idle-behavior';

interface AutonomyOptions {
  controller: PetController;
  /** 待机小动作总开关 */
  actionsEnabled: boolean;
  /** 主动搭话总开关 */
  proactiveEnabled: boolean;
  /** 正在聊天/流式输出时完全不动作，避免打断 */
  busy: boolean;
  /** 面板打开时也不动作 */
  panelOpen: boolean;
  onIdleAction: (action: IdleAction) => void;
  /** 需要外部去调 LLM；返回后由调用方决定是否成功 */
  onProactive: (hint: string, level: IdleLevel) => void;
  onWake: (hint: string) => void;
  /** 允许时，闲到一定程度她自己溜去逛 B 站 */
  browseEnabled: boolean;
  onBrowse: () => void;
}

const TICK_MS = 3000;

export function useAutonomy(opts: AutonomyOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const lastActiveRef = useRef(Date.now());
  const nextActionAtRef = useRef(0);
  /** 启动后先安静几分钟，别一开机就凑上来 */
  const lastSpeakRef = useRef(Date.now() - 4 * 60_000);
  /** 逛 B 站很吃大白饭，至少隔半小时一次 */
  const lastBrowseRef = useRef(0);
  const levelRef = useRef<IdleLevel>('active');
  const wakeHandledRef = useRef(false);

  const [level, setLevel] = useState<IdleLevel>('active');
  const [idleMinutes, setIdleMinutes] = useState(0);

  /** 任何真实互动都重置空闲计时 */
  const touch = useCallback(() => {
    lastActiveRef.current = Date.now();
    wakeHandledRef.current = false;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const o = optsRef.current;
      const now = Date.now();
      const idleMs = now - lastActiveRef.current;
      const next = levelFor(idleMs);

      if (next !== levelRef.current) {
        const prev = levelRef.current;
        levelRef.current = next;
        setLevel(next);
        setIdleMinutes(Math.round(idleMs / 60_000));

        // 从困/睡状态被叫醒：说一句
        if (levelAtLeast(prev, 'sleepy') && next === 'active' && !wakeHandledRef.current) {
          wakeHandledRef.current = true;
          lastSpeakRef.current = now;
          o.onWake(wakeHint(Math.round(idleMs / 60_000)));
          nextActionAtRef.current = now + randomInterval('idle');
          return;
        }
      } else if (next !== 'active') {
        setIdleMinutes(Math.round(idleMs / 60_000));
      }

      // 忙碌 / 面板打开 / 刚恢复互动 → 不动作
      if (o.busy || o.panelOpen || next === 'active') {
        nextActionAtRef.current = now + 5000;
        return;
      }

      if (now < nextActionAtRef.current) return;

      // 逛 B 站优先：只有真的闲到发慌才会想起来去看视频
      const browseChance =
        o.browseEnabled && levelAtLeast(next, 'restless')
          ? next === 'restless'
            ? 0.18
            : 0.22
          : 0;
      const canBrowse = now - lastBrowseRef.current > 30 * 60_000;

      if (browseChance > 0 && canBrowse && Math.random() < browseChance) {
        lastBrowseRef.current = now;
        lastSpeakRef.current = now;
        o.onBrowse();
        nextActionAtRef.current = now + randomInterval(next);
        return;
      }

      const chance = o.proactiveEnabled ? proactiveChance(next, new Date().getHours()) : 0;
      const canSpeak = now - lastSpeakRef.current > SPEAK_COOLDOWN;

      if (chance > 0 && canSpeak && Math.random() < chance) {
        lastSpeakRef.current = now;
        o.onProactive(proactiveHint(idleMs, next), next);
      } else if (o.actionsEnabled) {
        const action = pickIdleAction(next);
        if (action) o.onIdleAction(action);
      }

      nextActionAtRef.current = now + randomInterval(next);
    }, TICK_MS);

    return () => window.clearInterval(timer);
  }, []);

  return { level, idleMinutes, touch };
}
