/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import type { TranslationKey } from '../i18n';

// 自定义标题栏的窗口控制按钮：最小化、最大化/还原、关闭。
// 关闭原生装饰后由前端接管这些操作，同时监听窗口尺寸变化保持最大化图标状态同步。
export function TitlebarWindowControls({
  t,
}: {
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
}) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const currentWindow = getCurrentWindow();
      // 初始同步一次最大化状态，避免启动即最大化时图标显示错误。
      const syncMaximized = async () => {
        try {
          const maximized = await currentWindow.isMaximized();
          if (!disposed) {
            setIsMaximized(maximized);
          }
        } catch {
          // 忽略窗口状态查询失败，保持上一次的图标状态即可。
        }
      };
      await syncMaximized();
      // 拖动最大化、系统快捷键等都会触发 resize，用它统一驱动图标切换。
      unlisten = await currentWindow.onResized(() => {
        void syncMaximized();
      });
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 各窗口操作都动态引入 window API，复用应用其他位置的懒加载方式，避免非 Tauri 环境报错。
  const runWindowAction = (
    action: (currentWindow: import('@tauri-apps/api/window').Window) => void,
  ) => {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      action(getCurrentWindow());
    });
  };

  return (
    <div className="titlebar-window-controls">
      <button
        aria-label={t('windowMinimize')}
        className="titlebar-window-button"
        onClick={() => runWindowAction((currentWindow) => void currentWindow.minimize())}
        title={t('windowMinimize')}
        type="button"
      >
        <Minus size={16} />
      </button>
      <button
        aria-label={isMaximized ? t('windowRestore') : t('windowMaximize')}
        className="titlebar-window-button"
        onClick={() => runWindowAction((currentWindow) => void currentWindow.toggleMaximize())}
        title={isMaximized ? t('windowRestore') : t('windowMaximize')}
        type="button"
      >
        {isMaximized ? <Copy size={14} /> : <Square size={13} />}
      </button>
      <button
        aria-label={t('windowClose')}
        className="titlebar-window-button titlebar-window-close"
        onClick={() => runWindowAction((currentWindow) => void currentWindow.close())}
        title={t('windowClose')}
        type="button"
      >
        <X size={16} />
      </button>
    </div>
  );
}
