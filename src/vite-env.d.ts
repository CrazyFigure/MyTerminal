/// <reference types="vite/client" />

interface ImportMetaEnv {
  // 关于页展示的应用版本由 Vite 构建阶段从 package.json 注入，避免前端硬编码版本。
  readonly VITE_APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
