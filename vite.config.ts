import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

type PackageManifest = {
  version?: string;
};

// 关于页需要展示前端包版本；构建时从 package.json 注入，避免界面版本号写死后和发版标签脱节。
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as PackageManifest;

// 开发态只预构建首屏会直接使用的第三方依赖。Monaco 由文件编辑器动态加载，不能加入这里，
// 否则 Vite 会在白框阶段遍历其数千个源码模块，Windows 下可能阻塞数分钟。
const startupDependencies = [
  '@tauri-apps/api/core',
  '@tauri-apps/plugin-clipboard-manager',
  '@tauri-apps/plugin-dialog',
  '@xterm/addon-fit',
  '@xterm/xterm',
  'clsx',
  'lucide-react',
  'react',
  'react-dom/client',
  'react/jsx-dev-runtime',
  'zustand',
  'zustand/react/shallow',
];

// package.json 是前端展示版本的唯一来源；缺失版本时直接失败，避免发布出空版本或旧兜底版本。
if (!packageJson.version) {
  throw new Error('package.json is missing a version field.');
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version),
  },
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
    // Cargo 编译期间会持续改写 target；该目录既不是前端源码，也不能参与 HMR 监听。
    watch: {
      ignored: ['**/src-tauri/target/**', '**/.myterminal-data/**'],
    },
    // Rust 首次编译通常比这些转换更久，提前预热首屏大模块可把工作隐藏在窗口创建之前。
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/store.ts',
        './src/styles.css',
      ],
    },
  },
  optimizeDeps: {
    // 自动入口发现会误扫 src-tauri/target 内 Tauri 生成的 HTML；开发入口只能是根 index.html。
    entries: ['index.html'],
    // 禁止继续沿动态 import 发现依赖，保证 Monaco 和右侧 AI 面板保持真正的按需加载边界。
    noDiscovery: true,
    include: startupDependencies,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        // 不再手工把 node_modules 全部塞进兜底 vendor：之前的 manualChunks 会把 Monaco 及其共享运行时
        // 拉进静态 vendor，破坏 `lazy(() => import('./MonacoEditor'))` 的动态边界，导致首屏 modulepreload
        // 约 4 MB 的 monaco-vendor 并在启动即解析。改为让打包器按动态 import 自动分包，Monaco 只在打开
        // 编辑器时才请求。分包结构由 scripts/check-bundle-memory.mjs 守卫，避免 Monaco 回到首屏。
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }

          // 只对确定“首屏必用且与 Monaco 无关”的大依赖做稳定缓存分包，绝不提供兜底 vendor。
          if (id.includes('@xterm/')) {
            return 'xterm-vendor';
          }

          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'react-vendor';
          }

          // Monaco、@monaco-editor、tauri、lucide 等其余依赖交给打包器随各自 import 边界自动归组。
          return undefined;
        },
      },
    },
  },
});
