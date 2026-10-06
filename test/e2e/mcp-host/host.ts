// A minimal MCP Apps host for test/e2e/mcp-app.mjs: renders a ui:// resource in a sandboxed iframe like Claude or
// ChatGPT do, and forwards the view's tool calls to the test, which sends them to the real /mcp endpoint.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

declare global {
  interface Window {
    hostCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    hostOpened: string[];
    startHost: (html: string, args: Record<string, unknown>, result: unknown) => Promise<void>;
    hostTheme: (theme: 'light' | 'dark') => void;
  }
}

window.hostOpened = [];
window.startHost = async (html, args, result) => {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.cssText = 'width: 880px; height: 1200px; border: 0; display: block';
  document.body.append(iframe);
  const view = iframe.contentWindow as Window;
  // Hosts tell views their theme; this one starts light and can switch (window.hostTheme).
  const bridge = new AppBridge(null, { name: 'e2e-host', version: '1.0.0' }, { openLinks: {}, serverTools: {} }, { hostContext: { theme: 'light' } });
  window.hostTheme = (theme) => bridge.setHostContext({ theme });
  bridge.oncalltool = async (params) => (await window.hostCall(params.name, params.arguments ?? {})) as never;
  bridge.onopenlink = async ({ url }) => {
    window.hostOpened.push(url);
    return {};
  };
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: args });
    void bridge.sendToolResult(result as never);
  };
  // Listen before the view loads, so its first message can't be missed.
  await bridge.connect(new PostMessageTransport(view, view));
  iframe.srcdoc = html;
};
