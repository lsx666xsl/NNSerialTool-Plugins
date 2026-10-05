// Hello 示例视图插件：演示 DOM 挂载契约、主题继承、原始数据订阅。
// 真正开发时从这里删掉演示逻辑，保留骨架即可。
export default function activate(ctx) {
  ctx.registerView({
    id: 'hello',
    name: 'Hello',
    tip: '示例视图插件：会话列表 + 实时字节计数',
    blocks: 2,
    component: {
      mount(el, ctx) {
        let bytes = 0;
        let raf = 0;

        const render = () => {
          const c = ctx.themeColors();
          const sessions = ctx
            .listSessions()
            .map((s) => `<li><b>${s.name}</b> · ${s.type} · ${s.status === 'connected' ? '已连接' : '未连接'}</li>`)
            .join('');
          el.innerHTML = `
            <div style="padding:16px;font-family:inherit;color:${c.text};background:${c.bg};
                        min-height:100%;box-sizing:border-box">
              <h3 style="margin:0 0 8px;color:${c.text}">Hello 插件 👋</h3>
              <p style="margin:0 0 12px;color:${c.textDim};font-size:12px">
                已接收字节：<b style="color:${c.accent}">${bytes}</b>（任意会话 RX 均计数）
              </p>
              <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.8;color:${c.text}">
                ${sessions || '<li>暂无会话，先在左侧新建一个连接</li>'}
              </ul>
            </div>`;
        };

        const schedule = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            render();
          });
        };

        const offRaw = ctx.onRawData((e) => {
          bytes += e.bytes.length;
          schedule();
        });
        const offTheme = ctx.onThemeChange(schedule);
        render();

        return () => {
          if (raf) cancelAnimationFrame(raf);
          offRaw();
          offTheme();
        };
      },
      unmount(el) {
        el.innerHTML = '';
      },
    },
  });
}
