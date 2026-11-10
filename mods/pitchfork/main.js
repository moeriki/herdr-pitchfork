import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { spaces, focused, theme, exec, hc, home, nextCommand, run, notify, props } from 'herdr';
import { snapshot, control, controlGroup, namespaceOf, daemonUrl, daemonActions, groupActions } from './model.js';

async function execute(command, args, { autostart = true, ...options } = {}) {
  if (command !== 'pitchfork') return exec(command, args, options);
  // A local binary override must never leak to another machine.
  const binary = !options.on && props()?.binary || 'pitchfork';
  try {
    return autostart ? await exec(binary, args, options) : await exec('env', ['PITCHFORK_SUPERVISOR_AUTO_START=false', binary, ...args], options);
  } catch (e) {
    throw new Error(`Could not run ${binary} (${e.message || e}). Install Pitchfork, or set the panel's "binary" prop.`);
  }
}

export default class Pitchfork extends View {
  init(_props, cx) {
    this.rows = []; this.selected = null; this.all = false; this.key = null;
    this.target = null; this.loading = false; this.pending = {}; this.error = '';
    this.request = 0; this.contextEpoch = 0;
    cx.timer.every(2500, cx => this.refresh(cx));
    cx.spawn(async cx => {
      for (;;) {
        const cmd = await nextCommand();
        this.command(cmd, cx);
        cx.notify();
      }
    });
  }

  context() {
    const f = focused() || {};
    const space = spaces().find(s => s.id === f.space);
    return { space: space?.id, cwd: f.cwd || space?.folder, machine: space?.machine ?? null, all: this.all };
  }

  contextKey() {
    const c = this.context();
    return JSON.stringify([c.space, c.cwd, c.machine, c.all]);
  }

  refresh(cx) {
    const key = this.contextKey();
    const context = this.context();
    if (this.loading && key === this.key) return;
    if (key !== this.key) {
      this.contextEpoch++;
      this.key = key; this.target = null; this.rows = []; this.selected = null;
      this.error = '';

    }
    const request = ++this.request;
    const current = () => request === this.request && key === this.contextKey();
    this.loading = true;
    cx.spawn(async cx => {
      try {
        if (!context.cwd && !context.all) throw Object.assign(new Error('Select a space with a working folder.'), { info: true });
        let root;
        if (context.all) {
          // Resolve home on the target machine; never pass the local home to a remote core.
          const r = context.machine ? await exec('sh', ['-c', 'printf "%s" "$HOME"'], { on: context.machine }) : { code: 0, stdout: home() };
          if (r.code !== 0 || !r.stdout.trim()) throw new Error('Cannot resolve the machine home folder.');
          root = r.stdout.trim();
        } else {
          root = context.cwd;
        }
        const target = { root, machine: context.machine, all: context.all, space: context.space };
        const rows = await snapshot(execute, target);
        if (!current()) return;
        this.target = target; this.rows = rows;
        if (!rows.some(r => r.id === this.selected)) this.selected = rows[0]?.id ?? null;
        this.error = ''; this.down = false;
      } catch (e) {
        if (current()) {
          this.down = /connection_failed|failed to connect to supervisor/.test(e.message);
          this.error = this.down ? "Pitchfork's supervisor isn't running." : String(e.message || e);
          this.info = !!e.info || this.down; this.target = null;
        }
      } finally { if (request === this.request) this.loading = false; cx.notify(); }
    });
  }

  command(cmd, cx) {
    if (cmd === 'refresh') { this.refresh(cx); return; }
    if (cmd === 'next' || cmd === 'prev') {
      const i = this.rows.findIndex(r => r.id === this.selected);
      this.selected = this.rows[(i + (cmd === 'next' ? 1 : -1) + this.rows.length) % this.rows.length]?.id ?? null;
      return;
    }
    if (cmd === 'logs') {
      if (!this.selected || !this.target || this.key !== this.contextKey()) return;
      this.openLogs(this.selected, this.target, cx);
      return;
    }
    if (cmd === 'open') {
      if (!this.target || this.key !== this.contextKey() || this.error) return;
      const row = this.rows.find(r => r.id === this.selected);
      const url = daemonUrl(row);
      if (!url) return;
      // Browsers are local: do not invent localhost forwarding for remote daemons.
      if (this.target?.machine) { this.error = 'Remote URL: ' + url + ' (open it with your own forwarding).'; return; }
      cx.spawn(async cx => {
        try { const r = await exec('open', [url]).catch(() => exec('xdg-open', [url])); if (r.code !== 0) this.error = r.stderr; }
        catch(e) { this.error = String(e); }
        cx.notify();
      });
      return;
    }
    if (!['start', 'stop', 'restart'].includes(cmd) || !this.selected || !this.target || this.pending[this.selected] || this.key !== this.contextKey()) return;
    const id = this.selected, key = this.key, epoch = this.contextEpoch, target = { ...this.target };
    this.pending[id] = { start: 'starting', stop: 'stopping', restart: 'restarting' }[cmd];
    cx.spawn(async cx => {
      try {
        const result = await control(execute, target, id, cmd, () => key === this.contextKey() && epoch === this.contextEpoch);
        notify({ title: 'Pitchfork', body: `${id}: ${result.noop ? 'already in requested state' : cmd + ' command finished; checking status'}`, level: 'info' });
      } catch(e) {
        notify({ title: 'Pitchfork action needs attention', body: `${id}: ${String(e.message || e).slice(0, 600)}. Check status/logs before retrying; a timed-out start may still be running.`, level: 'error' });
      } finally { delete this.pending[id]; this.refresh(cx); cx.notify(); }
    });
  }

  openLogs(id, { root, machine, space }, cx) {
    // Herdr adopts a terminal labelled with an unknown tab id as a new tab under that id, so the id finds it again.
    const local = space.split('/').pop();
    const tab = 'pflogs-' + local.slice(-8) + '-' + id.replace(/[^a-z0-9-]/gi, '-');
    const shown = machine ? machine + '/' + tab : tab;
    if (spaces().some(s => s.id === space && s.tabs.some(t => t.id === shown))) { run('tab.select', { id: shown }); return; }
    const binary = !machine && props()?.binary || 'pitchfork';
    cx.spawn(async cx => {
      const r = await hc(['run', '--bg', '--no-parent', '--cwd', root, ...(machine ? ['--on', machine] : []),
        '--label', 'herdr.space=' + local, '--label', 'herdr.tab=' + tab, '--label', 'pitchfork.logs=' + id,
        '--', binary, 'logs', '-n', '200', '--tail', '--', id]);
      if (r.code !== 0) { notify({ title: 'Pitchfork logs', body: (r.stderr || r.stdout).trim(), level: 'error' }); return; }
      for (let i = 0; i < 20 && !spaces().some(s => s.tabs.some(t => t.id === shown)); i++) await cx.sleep(100);
      run('tab.rename', { id: shown, name: 'logs · ' + id.split('/').pop() });
      run('tab.select', { id: shown });
    });
  }

  startSupervisor(cx) {
    const { cwd, machine } = this.context();
    this.error = 'Starting the supervisor…'; this.down = false;
    cx.spawn(async cx => {
      try {
        const r = await execute('pitchfork', ['supervisor', 'start'], { cwd, on: machine, timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim());
      } catch(e) { notify({ title: 'Pitchfork supervisor', body: String(e.message || e).slice(0, 600), level: 'error' }); }
      this.refresh(cx); cx.notify();
    });
  }

  groupAction(action, cx) {
    if (!this.target || this.error || this.key !== this.contextKey()) return;
    const ids = this.rows.map(row => row.id);
    if (!ids.length || ids.some(id => this.pending[id])) return;
    const key = this.key, epoch = this.contextEpoch, target = { ...this.target };
    const running = this.rows.filter(row => action !== 'restart' || row.status === 'running').map(row => row.id);
    for (const id of running) this.pending[id] = { start: 'starting', stop: 'stopping', restart: 'restarting' }[action];
    cx.spawn(async cx => {
      try {
        await controlGroup(execute, target, ids, action, () => key === this.contextKey() && epoch === this.contextEpoch);
      } catch(e) {
        notify({ title: 'Pitchfork action needs attention', body: `${action} all: ${String(e.message || e).slice(0, 600)}. Check status before retrying; changes may be partial.`, level: 'error' });
      } finally { for (const id of running) delete this.pending[id]; this.refresh(cx); cx.notify(); }
    });
  }

  button(id, text, fn, t, style = 'ghost') {
    const solid = style === 'solid';
    return div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(11).cursor_pointer()
      .when(solid, el => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!solid, el => el.border_1().border_color(t.border).text_color(t.foreground).hover(s => s.bg(t.hover)))
      .on_mouse_down('left', (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); cx.notify(); }).child(text);
  }

  daemonControls(row, t) {
    const act = (action, cx) => {
      if (this.selected !== row.id) { this.selected = row.id; }
      this.command(action, cx);
    };
    const controls = h_flex().gap(4);
    for (const action of daemonActions(row, !!this.pending[row.id])) {
      controls.child(this.button('pf-' + action + '-' + row.id, action[0].toUpperCase() + action.slice(1),
        cx => act(action, cx), t, action === 'start' ? 'solid' : 'ghost'));
    }
    controls.child(this.button('pf-logs-' + row.id, 'Logs ↗', cx => act('logs', cx), t));
    if (daemonUrl(row)) controls.child(this.button('pf-open-' + row.id, this.target?.machine ? 'Remote URL' : 'Open ↗', cx => act('open', cx), t));
    return controls;
  }

  groupControls(t) {
    const controls = h_flex().gap(6);
    for (const action of groupActions(this.rows, this.rows.some(row => this.pending[row.id]))) {
      controls.child(this.button('pf-all-' + action, action[0].toUpperCase() + action.slice(1) + ' all',
        cx => this.groupAction(action, cx), t, action === 'start' ? 'solid' : 'ghost'));
    }
    return controls;
  }

  daemonRow(row, t) {
    const pending = this.pending[row.id];
    const color = pending ? t.accent : row.status === 'running' ? t.done : ['failed', 'errored'].includes(row.status) ? t.blocked : t.dim;
    const meta = [row.active_port ? ':' + row.active_port : '', row.pid ? 'pid ' + row.pid : '', row.oneshot ? 'oneshot' : ''].filter(Boolean).join(' · ');
    const url = daemonUrl(row);
    return v_flex().id('pf-row-' + row.id).flex_none().px(10).py(8).gap(6).rounded(7).cursor_pointer()
      .when(row.id === this.selected, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.selected = row.id; cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().size(7).flex_none().rounded(4).bg(color).when(!!pending, el => el.loop('opacity', { from: 0.3, to: 1, period: 900 })))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(row.name || row.id.split('/').pop()))
        .child(div().flex_none().text_size(11).text_color(color).child(pending ? pending + '…' : row.status)))
      .when(!!(meta || url), el => el.child(h_flex().pl(15).gap(6).text_size(11).text_color(t.dim)
        .when(!!meta, el => el.child(div().flex_none().child(meta + (url ? ' ·' : ''))))
        .when(!!url, el => el.child(div().flex_1().min_w(0).truncate().child(url.replace(/^https?:\/\//, ''))))))
      .when(!!row.error, el => el.child(div().pl(15).text_size(11).text_color(t.blocked).child(String(row.error))))
      .child(div().pl(15).child(this.daemonControls(row, t)));
  }

  render(cx) {
    const t = theme();
    if (this.contextKey() !== this.key) this.refresh(cx);
    const current = this.key === this.contextKey();
    const tab = (id, text, all) => div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .text_color(this.all === all ? t.foreground : t.dim).when(this.all === all, el => el.bg(t.raised)).hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.all = all; this.refresh(cx); cx.notify(); }).child(text);
    const root = v_flex().id('pitchfork').size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    root.child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child('Pitchfork'))
      .when(current && this.rows.length > 0, el => el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
        .child(`${this.rows.filter(r => r.status === 'running').length}/${this.rows.length} running`)))
      .child(div().flex_1())
      .child(h_flex().p(2).gap(2).rounded(7).border_1().border_color(t.border).child(tab('pf-current', 'Worktree', false)).child(tab('pf-all', 'All', true))));

    const list = v_flex().id('pf-list').flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2);
    const empty = !current ? 'Changing worktree…' : this.error || (!this.rows.length && (this.loading ? 'Reading Pitchfork…'
      : this.all ? 'No daemons configured.' : 'No Pitchfork daemons for this folder. Switch to All to see every daemon.'));
    if (empty) list.child(div().p(8).text_size(12).text_color(this.error && !this.info ? t.blocked : t.dim).child(empty));
    if (current && this.down) list.child(div().px(8).child(this.button('pf-supervisor', 'Start supervisor', cx => this.startSupervisor(cx), t, 'solid')));
    if (current && !this.error) {
      const namespaces = [...new Set(this.rows.map(namespaceOf))];
      namespaces.forEach((namespace, i) => {
        const members = this.rows.filter(row => namespaceOf(row) === namespace);
        const running = members.filter(row => row.status === 'running').length;
        if (namespace && (namespaces.length > 1 || this.all)) list.child(h_flex().flex_none().mt(i ? 10 : 2).mb(2).mx(4).px(6).pt(i ? 12 : 4).pb(4).gap(8).items_center()
          .when(i > 0, el => el.border_t(1).border_color(t.border))
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(namespace))
          .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10)
            .text_color(running ? t.done : t.muted).child(`${running}/${members.length}`)));
        for (const row of members) list.child(this.daemonRow(row, t));
      });
    }
    root.child(list);

    if (current && !this.all && groupActions(this.rows, this.rows.some(row => this.pending[row.id])).length)
      root.child(div().flex_none().p(10).border_t(1).border_color(t.border).child(this.groupControls(t)));
    return root;
  }
}
