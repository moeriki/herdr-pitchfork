// Pure Pitchfork adapter: no shell interpolation, no lifecycle hooks, no implicit starts.
const SLOW = { timeout: 600000 };
export function decode(result) {
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Exit ${result.code}`);
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.some(r => typeof r.id !== 'string' || typeof r.status !== 'string')) {
    throw new Error('Unsupported Pitchfork JSON response');
  }
  return rows;
}

export function disposition(action, row) {
  if (!row) throw new Error('Daemon no longer exists. Refresh and select again.');
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unsupported action');
  if (action === 'start' && row.status === 'running') return 'noop';
  if (action === 'stop' && ['stopped', 'available', 'completed', 'failed'].includes(row.status)) return 'noop';
  // Stop is how Pitchfork interrupts a retry or a pending start.
  if (row.status === 'stopping' || (action !== 'stop' && ['waiting', 'restarting'].includes(row.status))) throw new Error(`Daemon is ${row.status}; wait for its next status update.`);
  if (row.disabled && action !== 'stop') throw new Error('Daemon is disabled in Pitchfork. Enable it outside this panel first.');
  return 'run';
}

export async function snapshot(execute, target, { uptime = false } = {}) {
  // A poll must not spawn a supervisor with Herdr's environment; starting one is the user's call.
  const rows = decode(await execute('pitchfork', ['list', '--json', ...(target.all ? [] : ['--project'])], {
    cwd: target.root, on: target.machine, autostart: false,
  }));
  const pids = rows.filter(row => row.status === 'running' && Number.isInteger(row.pid)).map(row => row.pid);
  if (!uptime || !pids.length) return rows;
  // ps exits non-zero when any pid is gone but still prints the rest.
  const ps = await execute('ps', ['-o', 'pid=,etime=', '-p', pids.join(',')], { cwd: target.root, on: target.machine }).catch(() => null);
  const elapsed = new Map((ps?.stdout || '').split('\n').map(line => line.trim().split(/\s+/)).filter(([pid, e]) => pid && e).map(([pid, e]) => [Number(pid), e]));
  return rows.map(row => elapsed.has(row.pid) ? { ...row, uptime: formatElapsed(elapsed.get(row.pid)) } : row);
}

export function formatElapsed(etime) {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const [s, m = 0, h = 0] = clock.split(':').reverse().map(Number);
  const d = Number(days);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
}

export function namespaceOf(row) {
  const index = row.id.lastIndexOf('/');
  return index < 0 ? null : row.id.slice(0, index);
}

export function daemonUrl(row) {
  // Opening a stopped daemon's proxy URL makes Pitchfork start it.
  if (row?.status !== 'running') return null;
  const port = Number.isInteger(row.active_port) ? `http://localhost:${row.active_port}` : null;
  return [row.proxy_url, row.url, port].find(url => typeof url === 'string' && /^https?:\/\/\S+$/i.test(url)) || null;
}

export function daemonActions(row, busy = false) {
  if (busy) return [];
  if (row.status === 'running') return row.disabled ? ['stop'] : ['stop', 'restart'];
  if (['waiting', 'restarting'].includes(row.status)) return ['stop'];
  if (row.status === 'errored') return row.disabled ? ['stop'] : ['start', 'stop'];
  if (row.disabled) return [];
  return ['available', 'stopped', 'failed', 'completed'].includes(row.status) ? ['start'] : [];
}

const groupable = (action, row) => action !== 'restart' || row.status === 'running';

export function groupActions(rows, busy = false) {
  if (busy || !rows.length || rows.some(row => ['stopping', 'waiting', 'restarting'].includes(row.status))) return [];
  return ['start', 'restart', 'stop'].filter(action => {
    try { return rows.filter(row => groupable(action, row)).map(row => disposition(action, row)).includes('run'); }
    catch { return false; }
  });
}

export async function controlGroup(execute, target, ids, action, stillCurrent) {
  if (!ids.length || !['start', 'stop', 'restart'].includes(action)) throw new Error('Unsupported group action');
  const rows = (await snapshot(execute, { ...target, all: true })).filter(row => ids.includes(row.id));
  if (!stillCurrent()) throw new Error('Space or worktree changed. Try again.');
  if (!rows.length) throw new Error('Daemons no longer exist. Refresh first.');
  // Validate the entire group before sending any mutation.
  const run = rows.filter(row => groupable(action, row) && disposition(action, row) === 'run').map(row => row.id);
  if (!run.length) return { noop: true };
  const result = await execute('pitchfork', [action, '--', ...run], { cwd: target.root, on: target.machine, ...SLOW });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Exit ${result.code}`);
  return { noop: false };
}

export async function control(execute, target, id, action, stillCurrent) {
  // Re-read supervisor state immediately before every mutation. Never force-start.
  const rows = await snapshot(execute, target);
  if (!stillCurrent()) throw new Error('Space or worktree changed. Select the daemon again.');
  const row = rows.find(r => r.id === id);
  if (disposition(action, row) === 'noop') return { noop: true };
  const result = await execute('pitchfork', [action, '--', id], { cwd: target.root, on: target.machine, ...SLOW });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Exit ${result.code}`);
  // A command exit is not proof of readiness. The caller refreshes actual state.
  return { noop: false };
}
