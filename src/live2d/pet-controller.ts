import { Application, extensions, Ticker } from 'pixi.js';
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism';

extensions.add(Live2DPlugin);
Live2DModel.registerTicker(Ticker);

/** 情绪状态。每个非 idle 情绪会映射到一个 .exp3.json 表情。 */
export type PetMood =
  | 'idle'
  | 'happy'
  | 'excited'
  | 'sad'
  | 'angry'
  | 'shy'
  | 'dizzy'
  | 'thinking'
  | 'sleepy';

/** 模型自带的表情名（来自 c_0120.model3.json 的 Expressions 声明）。 */
const MOOD_EXPRESSION: Record<PetMood, string | null> = {
  idle: null,
  happy: '开心兴奋',
  excited: '星星眼',
  sad: '悲伤',
  angry: '生气',
  shy: '脸红',
  dizzy: '晕晕',
  thinking: '问号',
  sleepy: '闭眼口水',
};

/** 模型自带的动作组名。 */
export type PetMotion =
  | 'Idle'
  | 'Hammer'
  | 'BubbleGum'
  | 'SprayWater'
  | 'OpenCase'
  | 'Selfie'
  | 'SelfieQuick'
  | 'Ketchup';

interface Spring {
  value: number;
  velocity: number;
  target: number;
  stiffness: number;
  damping: number;
}

function makeSpring(value = 0, stiffness = 120, damping = 14): Spring {
  return { value, velocity: 0, target: 0, stiffness, damping };
}

function stepSpring(s: Spring, dt: number): void {
  const accel = (s.target - s.value) * s.stiffness - s.velocity * s.damping;
  s.velocity += accel * dt;
  s.value += s.velocity * dt;
}

export class PetController {
  private app: Application | null = null;
  private model: Live2DModel | null = null;

  private width = 0;
  private height = 0;

  private talking = false;
  private mouth = 0;
  private mouthPhase = 0;
  private mood: PetMood = 'idle';
  private moodHoldUntil = 0;

  /** 拖拽摆动：横向偏移驱动 rotation，纵向驱动 skew。 */
  private rotSpring = makeSpring(0, 150, 12);
  private skewSpring = makeSpring(0, 150, 12);

  /** 模型在窗口内的可见矩形，用于点击穿透的热区判定。 */
  private hitRect = { x: 0, y: 0, w: 0, h: 0 };

  private tickerHandler: (() => void) | null = null;
  private lastTick = 0;

  get isLoaded(): boolean {
    return this.model !== null;
  }

  async mount(canvas: HTMLCanvasElement, width: number, height: number, modelUrl: string): Promise<void> {
    this.width = width;
    this.height = height;

    const app = new Application();
    await app.init({
      canvas,
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      preference: 'webgl',
    });
    this.app = app;

    const model = await Live2DModel.from(modelUrl, {
      autoInteract: false,
      autoUpdate: true,
      // 一屏一只，纹理按屏幕尺寸降采样，省显存
      textureOptions: { lod: 'single-auto' },
    });
    this.model = model;

    model.anchor.set(0.5, 0.5);
    app.stage.addChild(model);

    this.applyLayout();

    // 嘴型同步：在所有动作更新完、核心模型 update 之前写入参数
    model.internalModel.on('beforeModelUpdate', () => {
      const core = model.internalModel.coreModel as unknown as {
        setParameterValueById: (id: string, value: number, weight?: number) => void;
      };
      core.setParameterValueById('ParamMouthOpenY', this.mouth, 1);
    });

    // 起始动作
    model.motion('Idle', 0, undefined, { loop: true });

    this.lastTick = performance.now();
    this.tickerHandler = () => this.tick();
    app.ticker.add(this.tickerHandler);
  }

  private applyLayout(): void {
    const model = this.model;
    if (!model) return;

    const im = model.internalModel as unknown as { width?: number; height?: number };
    const baseW = im.width && im.width > 0 ? im.width : model.width;
    const baseH = im.height && im.height > 0 ? im.height : model.height;
    if (!baseW || !baseH) return;

    // 留一点边距，避免头发/头顶贴到窗口边缘被裁掉
    const scale = Math.min(this.width / baseW, this.height / baseH) * 1.02;

    model.scale.set(scale);
    model.position.set(this.width / 2, this.height * 0.5);

    // 包围盒往内收一圈：模型贴图四周有大片透明边，
    // 直接用满尺寸会让热区比角色本人胖一圈，挡住本该穿透的点击。
    const visW = baseW * scale * 0.74;
    const visH = baseH * scale * 0.92;
    this.hitRect = {
      x: this.width / 2 - visW / 2,
      y: this.height * 0.5 - visH / 2,
      w: visW,
      h: visH,
    };
  }

  getHitRect(): { x: number; y: number; w: number; h: number } {
    return this.hitRect;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (!this.app) return;
    this.app.renderer.resize(width, height);
    this.applyLayout();
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.05);
    this.lastTick = now;

    if (this.talking) {
      // 说话时的高频开合，叠加随机扰动让口型不机械
      this.mouthPhase += dt * 17;
      const wave = Math.abs(Math.sin(this.mouthPhase));
      const jitter = 0.72 + Math.random() * 0.28;
      const target = 0.18 + wave * 0.62 * jitter;
      this.mouth += (target - this.mouth) * Math.min(1, dt * 28);
    } else {
      this.mouth += (0 - this.mouth) * Math.min(1, dt * 12);
    }

    stepSpring(this.rotSpring, dt);
    stepSpring(this.skewSpring, dt);

    const model = this.model;
    if (model) {
      model.rotation = this.rotSpring.value;
      model.skew.x = this.skewSpring.value * 0.6;
      model.skew.y = this.skewSpring.value * -0.2;

      if (this.mood !== 'idle' && now > this.moodHoldUntil) {
        this.setMood('idle');
      }
    }
  }

  setTalking(on: boolean): void {
    this.talking = on;
    if (on) this.mouthPhase = 0;
  }

  setMood(mood: PetMood, holdMs = 2600): void {
    if (!this.model) return;
    if (mood === this.mood && mood !== 'idle') return;

    this.mood = mood;
    this.moodHoldUntil = performance.now() + holdMs;

    const expression = MOOD_EXPRESSION[mood];
    if (expression) {
      void this.model.expression(expression);
    } else {
      void this.model.expression();
    }
  }

  playMotion(motion: PetMotion): void {
    this.model?.motion(motion, 0);
  }

  /** 视线跟随。传入舞台坐标（canvas 内像素）。 */
  focusAt(x: number, y: number): void {
    if (!this.model) return;
    this.model.focus(x, y);
  }

  /**
   * 拖拽摆动。传入窗口的瞬时位移（像素），转成弹簧目标角度。
   * 松手后由弹簧自然回正，形成惯性感。
   */
  nudge(dx: number, dy: number): void {
    const k = 0.0016;
    this.rotSpring.target = Math.max(-0.22, Math.min(0.22, this.rotSpring.target - dx * k));
    this.skewSpring.target = Math.max(-0.2, Math.min(0.2, this.skewSpring.target + dy * k));
    this.rotSpring.value += -dx * k * 0.35;
    this.skewSpring.value += dy * k * 0.35;
  }

  /** 松手后让弹簧回到中立位。 */
  release(): void {
    this.rotSpring.target = 0;
    this.skewSpring.target = 0;
  }

  destroy(): void {
    if (this.app && this.tickerHandler) {
      this.app.ticker.remove(this.tickerHandler);
    }
    this.tickerHandler = null;
    this.model?.destroy();
    this.model = null;
    this.app?.destroy(false, { children: true });
    this.app = null;
  }
}
