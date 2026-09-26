// Cline Pass Switcher —— 预加载脚本（CommonJS：sandbox 模式下预加载必须是 CJS）
// 只通过 contextBridge 暴露一组受控的、可枚举的能力，渲染层拿不到 Node / ipcRenderer 本体。
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => {
    try { callback(payload); } catch (e) { console.error('[渲染层回调异常] ' + e.message); }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('cp', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),

  engine: {
    start: (opts) => ipcRenderer.invoke('engine:start', opts),
    stop: () => ipcRenderer.invoke('engine:stop'),
    restart: (opts) => ipcRenderer.invoke('engine:restart', opts),
    status: () => ipcRenderer.invoke('engine:status'),
    logs: () => ipcRenderer.invoke('engine:logs'),
    clearLogs: () => ipcRenderer.invoke('engine:clearLogs'),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  config: {
    patch: (patch) => ipcRenderer.invoke('config:patch', patch),
    exportFile: () => ipcRenderer.invoke('config:export'),
    importFile: () => ipcRenderer.invoke('config:import'),
  },

  // CC Switch 集成：只暴露「唤起深链接」和「探测是否安装」，不暴露任意 scheme
  ccswitch: {
    open: (link) => ipcRenderer.invoke("ccswitch:open", link),
    detect: () => ipcRenderer.invoke("ccswitch:detect"),
  },

  // Claude Code 的 ~/.claude/settings.json：只暴露这五个动作，不暴露任意路径读写
  claude: {
    info: () => ipcRenderer.invoke('claude:info'),
    preview: (payload) => ipcRenderer.invoke('claude:preview', payload),
    write: (payload) => ipcRenderer.invoke('claude:write', payload),
    restore: () => ipcRenderer.invoke('claude:restore'),
    reveal: () => ipcRenderer.invoke('claude:reveal'),
  },

  app: {
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    copy: (text) => ipcRenderer.invoke('app:copy', text),
    openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
    showWindow: () => ipcRenderer.invoke('app:showWindow'),
    quit: () => ipcRenderer.invoke('app:quit'),
  },

  // 用量接口与真实代理调用都放在主进程：渲染层 fetch 读不到 X-Cline-* 响应头，也受 CORS 限制。
  quota: {
    fetch: (key, opts) => ipcRenderer.invoke('quota:fetch', key, opts),
  },

  proxy: {
    chat: (payload) => ipcRenderer.invoke('proxy:chat', payload),
  },

  onLog: (cb) => subscribe('engine:log', cb),
  onEngineState: (cb) => subscribe('engine:state', cb),
});
