import { useEffect, useRef, useState } from 'react';
import type { PetController } from '../live2d/pet-controller';

interface PetStageProps {
  controller: PetController;
  modelUrl: string;
  onReady?: () => void;
}

export function PetStage({ controller, modelUrl, onReady }: PetStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    const width = window.innerWidth;
    const height = window.innerHeight;

    controller
      .mount(canvas, width, height, modelUrl)
      .then(() => {
        if (disposed) {
          controller.destroy();
          return;
        }
        onReady?.();
      })
      .catch((err: unknown) => {
        console.error('[pet] mount failed', err);
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });

    const onResize = () => {
      controller.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      controller.destroy();
    };
  }, [controller, modelUrl, onReady]);

  return (
    <>
      <canvas ref={canvasRef} className="pet-canvas" />
      {error && <div className="pet-error">模型加载失败：{error}</div>}
    </>
  );
}
