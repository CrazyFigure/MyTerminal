import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { backend } from './backend';
import { translate } from './i18n';
import type { AppSettings, TerminalOutputChunk, TerminalSession } from './types';

import '@xterm/xterm/css/xterm.css';

type Props = {
  session?: TerminalSession;
  settings: AppSettings;
  onTerminalData: (data: string) => void;
};

const terminalOutputEventName = 'myterminal-terminal-output';
const maxCachedTerminalOutputLength = 1_000_000;

// 只有可交互会话才接收键盘输入，关闭或异常状态由标签栏图标提示，不在终端正文里叠加状态层。
const canAcceptTerminalInput = (session?: TerminalSession) => Boolean(session && !['closed', 'error'].includes(session.status));

// 终端彩色文本使用清晰的 ANSI 调色板；浅色终端里 ANSI white 也要落到深灰，避免 ls 高亮发白发虚。
const buildTerminalTheme = (settings: AppSettings) => {
  const isDarkTheme = settings.themeMode === 'dark';

  return {
    background: settings.terminalBackground,
    foreground: settings.terminalForeground,
    cursor: settings.accentColor,
    selectionBackground: isDarkTheme ? '#334155' : '#bfdbfe',
    black: isDarkTheme ? '#020617' : '#374151',
    red: '#dc2626',
    green: '#059669',
    yellow: isDarkTheme ? '#f59e0b' : '#b45309',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: isDarkTheme ? '#e5e7eb' : '#374151',
    brightBlack: isDarkTheme ? '#64748b' : '#6b7280',
    brightRed: '#ef4444',
    brightGreen: '#10b981',
    brightYellow: isDarkTheme ? '#fbbf24' : '#d97706',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: isDarkTheme ? '#f9fafb' : '#111827',
  };
};

export function TerminalWorkspace({ session, settings, onTerminalData }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cachedOutputBySessionRef = useRef<Record<string, string>>({});
  const onTerminalDataRef = useRef(onTerminalData);
  const sessionRef = useRef<TerminalSession | undefined>(session);
  const resizeFrameRef = useRef<number | null>(null);
  const terminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    onTerminalDataRef.current = onTerminalData;
  }, [onTerminalData]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      disableStdin: !canAcceptTerminalInput(sessionRef.current),
      fontFamily: settings.shellFontFamily,
      fontSize: settings.shellFontSize,
      lineHeight: 1.18,
      theme: buildTerminalTheme(settings),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    const syncTerminalSize = () => {
      fitAddon.fit();
      const currentSession = sessionRef.current;
      const nextSize = { cols: terminal.cols, rows: terminal.rows };
      const previousSize = terminalSizeRef.current;
      terminalSizeRef.current = nextSize;
      // 只有终端列/行实际变化时才通知后端，避免拖动和窗口变化期间频繁 IPC 造成选区和输入卡顿。
      if (currentSession && (!previousSize || previousSize.cols !== nextSize.cols || previousSize.rows !== nextSize.rows)) {
        void backend.resizeTerminal(currentSession.id, terminal.cols, terminal.rows);
      }
    };

    const scheduleTerminalSizeSync = () => {
      if (resizeFrameRef.current !== null) {
        return;
      }

      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        syncTerminalSize();
      });
    };

    const dataDisposable = terminal.onData((data) => {
      if (canAcceptTerminalInput(sessionRef.current)) {
        onTerminalDataRef.current(data);
      }
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(scheduleTerminalSizeSync);
    observer.observe(containerRef.current);
    window.addEventListener('resize', scheduleTerminalSizeSync);

    return () => {
      dataDisposable.dispose();
      observer.disconnect();
      window.removeEventListener('resize', scheduleTerminalSizeSync);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [settings.accentColor, settings.shellFontFamily, settings.shellFontSize, settings.terminalBackground, settings.terminalForeground]);

  useEffect(() => {
    const handleTerminalOutput = (event: Event) => {
      const chunk = (event as CustomEvent<TerminalOutputChunk>).detail;
      if (!chunk?.sessionId || !chunk.content) {
        return;
      }

      // 终端输出直接写入 xterm，避免每 80ms 把大字符串塞进 React 状态导致输入、滚动和选区明显卡顿。
      const cached = `${cachedOutputBySessionRef.current[chunk.sessionId] ?? ''}${chunk.content}`;
      cachedOutputBySessionRef.current[chunk.sessionId] =
        cached.length > maxCachedTerminalOutputLength ? cached.slice(-maxCachedTerminalOutputLength) : cached;

      if (sessionRef.current?.id === chunk.sessionId) {
        terminalRef.current?.write(chunk.content);
      }
    };

    window.addEventListener(terminalOutputEventName, handleTerminalOutput);
    return () => window.removeEventListener(terminalOutputEventName, handleTerminalOutput);
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.disableStdin = !canAcceptTerminalInput(session);
    terminal.options.fontFamily = settings.shellFontFamily;
    terminal.options.fontSize = settings.shellFontSize;
    terminal.options.theme = buildTerminalTheme(settings);

    window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const nextSize = { cols: terminal.cols, rows: terminal.rows };
      const previousSize = terminalSizeRef.current;
      terminalSizeRef.current = nextSize;
      if (session && (!previousSize || previousSize.cols !== nextSize.cols || previousSize.rows !== nextSize.rows)) {
        void backend.resizeTerminal(session.id, terminal.cols, terminal.rows);
      }
    });
  }, [session, settings]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.reset();
    if (session?.id) {
      terminal.write(cachedOutputBySessionRef.current[session.id] ?? '');
    }
    fitAddonRef.current?.fit();
  }, [session?.id]);

  return (
    <section className="terminal-workspace card">
      <div className="terminal-surface" ref={containerRef} style={{ background: settings.terminalBackground }} />

      {!session ? (
        <div className="terminal-empty-state">
          <p>{translate(settings.uiLanguage, 'terminalPlaceholder')}</p>
        </div>
      ) : null}
    </section>
  );
}
