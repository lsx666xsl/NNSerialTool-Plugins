// 插件本地类型（自包含，不依赖应用源码；与宿主 PluginContext 契约同源）。
// onSessionsChange / exportTextFiles 为可选能力（宿主 0.5.2 起提供），使用前做存在性探测。
export type ThemeName = 'light' | 'dark';

export interface ThemeColors {
  bg: string;
  panel: string;
  border: string;
  text: string;
  textDim: string;
  grid: string;
  accent: string;
  palette: string[];
}

export interface SessionSnapshot {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'closed';
}

export interface RawDataEvent {
  sessionId: string;
  sessionName: string;
  bytes: Uint8Array;
  t: number;
}

export interface WaveFrame {
  t: number;
  channels: number[];
  seq?: number;
}

export interface ParserInstance {
  feed(bytes: Uint8Array, t: number): WaveFrame[];
  reset(): void;
}

export interface FirmwareFile {
  name: string;
  text: string;
}

export interface PluginContext {
  readonly pluginId: string;
  theme(): ThemeName;
  themeColors(): ThemeColors;
  onThemeChange(cb: (t: ThemeName) => void): () => void;
  listSessions(): SessionSnapshot[];
  onSessionsChange?(cb: (list: SessionSnapshot[]) => void): () => void;
  onRawData(cb: (e: RawDataEvent) => void): () => void;
  notify(text: string): void;
  exportTextFiles?(title: string, files: FirmwareFile[]): Promise<string>;
  storage: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
  };
  registerView(def: {
    id: string;
    name: string;
    tip: string;
    blocks?: number;
    component: {
      mount(el: HTMLElement, ctx: PluginContext): void | (() => void);
      unmount?(el: HTMLElement): void;
    };
  }): void;
  registerProtocol(def: {
    id: string;
    name: string;
    description?: string;
    createParser(): ParserInstance;
  }): void;
  log(...args: unknown[]): void;
}
