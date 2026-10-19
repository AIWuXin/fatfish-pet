/**
 * 生物钟。
 *
 * 她住在你电脑里，应该跟着你的时间过日子：
 * 早上刚醒会迷糊，深夜会困，周末赖床。
 *
 * 这里只输出**状态描述**，不输出台词。
 * 反面例子："现在是 22 点，你应该说晚安了" —— 那是查表，说出来像公告。
 * 正面例子："现在晚上十一点多，你眼皮开始打架，但还不舍得睡" —— 她自己会演。
 *
 * 一条硬约束：**清醒度不影响是否回应**。
 * 半夜找她，她还是回，只是迷糊。
 */

export type Wakefulness = 'deep-night' | 'dawn' | 'morning' | 'forenoon' | 'noon' | 'afternoon' | 'evening' | 'night';

export interface ClockState {
  /** 0-23 */
  hour: number;
  minute: number;
  /** 0=周日 */
  weekday: number;
  /** 当前时段 */
  phase: Wakefulness;
  /** 清醒度 0..1，用来给自主行为调频 */
  alertness: number;
  /** 现在几点的自然说法（"晚上十一点"） */
  label: string;
  /** 给模型的状态描述 */
  hint: string;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function hourLabel(h: number): string {
  if (h === 0) return '半夜十二点';
  if (h < 6) return `凌晨${h}点`;
  if (h < 9) return `早上${h}点`;
  if (h < 12) return `上午${h}点`;
  if (h === 12) return '中午十二点';
  if (h < 18) return `下午${h - 12}点`;
  if (h < 24) return `晚上${h - 12}点`;
  return '深夜';
}

interface PhaseInfo {
  alertness: number;
  hint: string;
}

function phaseOf(hour: number, isWeekend: boolean): { phase: Wakefulness; info: PhaseInfo } {
  // 深夜：困得厉害，说话短
  if (hour >= 0 && hour < 5) {
    return {
      phase: 'deep-night',
      info: {
        alertness: 0.12,
        hint: '这个点你本该睡着了，脑子糊成一团，回话会很短，容易打错字、说到一半忘词。撑着回他，但明显没精神。',
      },
    };
  }
  // 黎明：刚被叫醒，还没上线
  if (hour >= 5 && hour < 7) {
    return {
      phase: 'dawn',
      info: {
        alertness: 0.28,
        hint: '天刚亮，你迷迷糊糊刚醒，还带着起床气，反应慢半拍。',
      },
    };
  }
  // 早上
  if (hour >= 7 && hour < 9) {
    return {
      phase: 'morning',
      info: isWeekend
        ? { alertness: 0.42, hint: '周末早上，你赖在床上不想起，说话有点懒洋洋的。' }
        : { alertness: 0.55, hint: '刚醒没多久，人已经清醒了，但还没完全进入状态。' },
    };
  }
  // 上午：一天里最精神的时候
  if (hour >= 9 && hour < 12) {
    return {
      phase: 'forenoon',
      info: { alertness: 0.92, hint: '上午，你脑子最清楚的时候，说话利索、爱接话。' },
    };
  }
  // 中午：饭后困
  if (hour >= 12 && hour < 14) {
    return {
      phase: 'noon',
      info: { alertness: 0.6, hint: '刚吃完饭，有点饭气攻心，懒懒的想躺一会儿。' },
    };
  }
  // 下午：正常
  if (hour >= 14 && hour < 18) {
    return {
      phase: 'afternoon',
      info: { alertness: 0.8, hint: '下午，状态还行，就是容易走神。' },
    };
  }
  // 傍晚
  if (hour >= 18 && hour < 21) {
    return {
      phase: 'evening',
      info: { alertness: 0.72, hint: '晚上了，你松下来了，比较愿意聊天。' },
    };
  }
  // 夜里：开始困
  if (hour >= 21 && hour < 23) {
    return {
      phase: 'night',
      info: {
        alertness: 0.5,
        hint: '夜里了，你开始有点困，但还想再待一会儿，不太舍得睡。',
      },
    };
  }
  // 23 点后：困但嘴硬
  return {
    phase: 'night',
    info: {
      alertness: 0.3,
      hint: '快十二点了，困得眼睛都睁不开，但嘴上还说自己不困。',
    },
  };
}

export function readClock(now: Date = new Date()): ClockState {
  // 测试钩子：设置 localStorage.fatfish.debugHour 可以假装现在是几点
  const dbg = typeof localStorage !== 'undefined' ? localStorage.getItem('fatfish.debugHour') : null;
  if (dbg !== null) {
    const h = Number(dbg);
    if (Number.isFinite(h) && h >= 0 && h <= 23) {
      now = new Date(now.getTime());
      now.setHours(h, 30, 0, 0);
    }
  }
  const hour = now.getHours();
  const minute = now.getMinutes();
  const weekday = now.getDay();
  const isWeekend = weekday === 0 || weekday === 6;
  const { phase, info } = phaseOf(hour, isWeekend);
  return {
    hour,
    minute,
    weekday,
    phase,
    alertness: info.alertness,
    label: hourLabel(hour),
    hint: info.hint,
  };
}

/**
 * 生成给模型的时间状态。
 *
 * 只在**状态值得说**的时候才展开，否则只给一句时间，
 * 免得她每次开口都要报时。
 */
export function buildClockBlock(clock: ClockState): string {
  const weekendNote = clock.weekday === 0 || clock.weekday === 6 ? `，${WEEKDAY_NAMES[clock.weekday]}` : '';
  return `

## 现在几点
${clock.label}${weekendNote}。
${clock.hint}

注意：不要主动报时，也不要说"现在是几点"这种话。
这个状态是让你**演出来**的——困了就话短、有精神就多聊两句。
他是任何时间来找你你都会回的，只是状态不一样。`;
}

/** 深夜/凌晨时她该有的小动作提示，供自主行为用 */
export function sleepHint(clock: ClockState): string | null {
  if (clock.phase === 'deep-night' || clock.phase === 'dawn') return '打哈欠';
  if (clock.phase === 'noon') return '打哈欠';
  if (clock.phase === 'night' && clock.hour >= 23) return '揉眼睛';
  return null;
}
