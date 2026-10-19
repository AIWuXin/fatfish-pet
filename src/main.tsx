import { Component, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * 兜底：任何渲染异常都不该让整个桌宠变成一块白板。
 * 之前热更新时踩过一次整窗白屏，只有左上角剩个图标，什么都恢复不了。
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[pet] render crash', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="pet-error">
          界面出错了：{this.state.error.message}
          <br />
          点托盘图标或按 Ctrl+Alt+Shift+F 重新叫出来。
        </div>
      );
    }
    return this.props.children;
  }
}

// 不用 StrictMode：开发时的双次挂载会重复创建 WebGL 上下文和 Live2D 运行时
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
